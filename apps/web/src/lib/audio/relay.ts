// WebSocket binary audio relay — raw PCM Int16 @ 16 kHz
//
// Capture: fresh AudioContext + fresh getUserMedia stream per PTT press.
//          Reusing a MediaStreamTrack across AudioContext instances causes audio
//          degradation (slowmo / pitch issues) on iOS / Android after the first cycle.
//          AudioWorklet resamples from device native rate → 16 kHz (linear interp).
//          ScriptProcessorNode fallback uses txCtx.sampleRate (actual context rate)
//          NOT track.getSettings().sampleRate — iOS returns the *requested* rate
//          (16 kHz) there, which yields ratio = 1 and causes 3× slowmo.
// Playback: jitter buffer (PREBUFFER_CHUNKS × 32 ms ≈ 128 ms) before scheduling.
//           Audio routed through a radio bandpass + saturation chain.

import { writable } from 'svelte/store';

const SAMPLE_RATE   = 16000;
const WORKLET_CHUNK = 512;   // 32 ms @ 16 kHz
const FALLBACK_BUF  = 1024;
const PREBUFFER_CHUNKS = 4;  // ~128 ms jitter buffer

// ── Sender ──────────────────────────────────────────────
let localStream: MediaStream | null = null;
let txCtx: AudioContext | null = null;
let sourceNode: MediaStreamAudioSourceNode | null = null;
let captureNode: AudioWorkletNode | ScriptProcessorNode | null = null;
let silentOut: GainNode | null = null;

export async function startCapture(
  onChunk: (data: ArrayBuffer) => void,
): Promise<number> {
  // Always get a fresh stream — stopCapture releases it so this always runs.
  localStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
      sampleRate: SAMPLE_RATE,
    },
    video: false,
  });

  // Fresh AudioContext per PTT press — avoids worklet re-init issues on mobile.
  txCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
  if (txCtx.state === 'suspended') await txCtx.resume();

  sourceNode = txCtx.createMediaStreamSource(localStream);
  silentOut  = txCtx.createGain();
  silentOut.gain.value = 0;

  let usingWorklet = false;
  try {
    await txCtx.audioWorklet.addModule('/audio-capture-processor.js');
    const wn = new AudioWorkletNode(txCtx, 'audio-capture-processor', {
      processorOptions: { chunkSize: WORKLET_CHUNK, targetRate: SAMPLE_RATE },
    });
    wn.port.onmessage = (e) => {
      if (e.data instanceof ArrayBuffer) onChunk(e.data);
    };
    captureNode = wn;
    usingWorklet = true;
  } catch {
    // Fallback: ScriptProcessorNode.
    // Use txCtx.sampleRate (ACTUAL context rate, e.g. 44100 or 48000 on iOS) —
    // NOT track.getSettings().sampleRate which iOS reports as the requested value.
    const ratio = txCtx.sampleRate / SAMPLE_RATE;
    const sp = txCtx.createScriptProcessor(FALLBACK_BUF, 1, 1);
    sp.onaudioprocess = (e) => {
      const f32    = e.inputBuffer.getChannelData(0);
      const outLen = Math.floor(f32.length / ratio);
      const i16    = new Int16Array(outLen);
      for (let i = 0; i < outLen; i++) {
        const pos  = i * ratio;
        const lo   = Math.floor(pos);
        const hi   = Math.min(lo + 1, f32.length - 1);
        const frac = pos - lo;
        const s    = Math.max(-1, Math.min(1, f32[lo] * (1 - frac) + f32[hi] * frac));
        i16[i] = s < 0 ? s * 32768 : s * 32767;
      }
      onChunk(i16.buffer);
    };
    captureNode = sp;
  }

  sourceNode.connect(captureNode);
  captureNode.connect(silentOut);
  silentOut.connect(txCtx.destination);

  console.log(`[relay] TX via ${usingWorklet ? 'AudioWorklet' : 'ScriptProcessor'} @ ${txCtx.sampleRate}Hz → ${SAMPLE_RATE}Hz`);
  return SAMPLE_RATE;
}

export function stopCapture(): void {
  captureNode?.disconnect();
  sourceNode?.disconnect();
  silentOut?.disconnect();
  if (captureNode instanceof AudioWorkletNode) captureNode.port.close();
  captureNode = sourceNode = silentOut = null;
  txCtx?.close();
  txCtx = null;
  // Release stream — reusing a MediaStreamTrack across AudioContext instances
  // accumulates state on iOS/Android and causes slowmo/distortion each cycle.
  localStream?.getTracks().forEach((t) => t.stop());
  localStream = null;
}

export function releaseStream(): void {
  stopCapture(); // stopCapture now also releases the stream
}

// Call once on page load to trigger the browser mic-permission dialog early,
// before the user presses PTT, so the first transmission is never interrupted.
export async function requestMicPermission(): Promise<void> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices) return;
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    s.getTracks().forEach((t) => t.stop());
  } catch {
    // Denied or unavailable — PTT will surface the error when pressed
  }
}

export function getSupportedMimeType(): string {
  return '';
}

// ── Receiver ─────────────────────────────────────────────

const PREBUFFER_CHUNKS_COUNT = PREBUFFER_CHUNKS;

// Exported store — true while the jitter buffer is filling
export const audioBuffering = writable(false);

let rxCtx: AudioContext | null = null;
let rxChainInput: AudioNode | null = null;
let nextPlayTime = 0;
let incomingSampleRate = SAMPLE_RATE;
let prebuffer: Float32Array[] = [];
let playbackStarted = false;
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && rxCtx && rxCtx.state === 'suspended') {
      // AudioContext was suspended while in background (iOS Safari etc.) —
      // close it so next chunk recreates fresh without a stale burst.
      rxCtx.close().catch(() => {});
      rxCtx = null;
      rxChainInput = null;
      prebuffer = [];
      playbackStarted = false;
      nextPlayTime = 0;
      audioBuffering.set(false);
    }
    // When going to background: do nothing — let audio keep playing.
  });
}

function makeDistortionCurve(amount: number): Float32Array {
  const n = 256;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / (n - 1) - 1;
    curve[i] = ((Math.PI + amount) * x) / (Math.PI + amount * Math.abs(x));
  }
  return curve;
}

function getOrCreateRxCtx(): { ctx: AudioContext; input: AudioNode } {
  if (!rxCtx || rxCtx.state === 'closed') {
    rxCtx = new AudioContext({ sampleRate: SAMPLE_RATE });

    const hp = rxCtx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 300;
    hp.Q.value = 0.9;

    const lp = rxCtx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 3400;
    lp.Q.value = 0.9;

    const ws = rxCtx.createWaveShaper();
    ws.curve = makeDistortionCurve(40);
    ws.oversample = '2x';

    const gain = rxCtx.createGain();
    gain.gain.value = 2.2;

    const comp = rxCtx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.knee.value = 8;
    comp.ratio.value = 4;
    comp.attack.value = 0.003;
    comp.release.value = 0.08;

    hp.connect(lp);
    lp.connect(ws);
    ws.connect(gain);
    gain.connect(comp);
    comp.connect(rxCtx.destination);

    rxChainInput = hp;
  }
  return { ctx: rxCtx, input: rxChainInput! };
}

export function beginReceiving(_mimeType: string, sampleRate?: number): void {
  incomingSampleRate = sampleRate ?? SAMPLE_RATE;
  nextPlayTime = 0;
  prebuffer = [];
  playbackStarted = false;
  audioBuffering.set(true);
}

function scheduleChunk(f32: Float32Array, ctx: AudioContext, input: AudioNode): void {
  const now = ctx.currentTime;
  if (nextPlayTime < now - 0.2) nextPlayTime = now + 0.01;
  const startAt = Math.max(now + 0.01, nextPlayTime);
  const buf = ctx.createBuffer(1, f32.length, incomingSampleRate);
  buf.copyToChannel(f32, 0);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(input);
  src.start(startAt);
  src.onended = () => src.disconnect();
  nextPlayTime = startAt + buf.duration;
}

export function receiveChunk(data: ArrayBuffer): void {
  const i16 = new Int16Array(data);
  const f32 = new Float32Array(i16.length);
  for (let i = 0; i < i16.length; i++) {
    f32[i] = i16[i] / 32768;
  }

  const { ctx, input } = getOrCreateRxCtx();

  const doSchedule = () => {
    if (!playbackStarted) {
      prebuffer.push(f32);
      if (prebuffer.length >= PREBUFFER_CHUNKS_COUNT) {
        playbackStarted = true;
        audioBuffering.set(false);
        for (const chunk of prebuffer) scheduleChunk(chunk, ctx, input);
        prebuffer = [];
      }
    } else {
      scheduleChunk(f32, ctx, input);
    }
  };

  if (ctx.state === 'suspended') {
    ctx.resume().then(doSchedule).catch(console.error);
  } else {
    doSchedule();
  }
}

export function playReceived(): void {
  // Flush any remaining prebuffer chunks when transmission ends
  if (prebuffer.length > 0) {
    const { ctx, input } = getOrCreateRxCtx();
    const flush = () => {
      for (const chunk of prebuffer) scheduleChunk(chunk, ctx, input);
      prebuffer = [];
    };
    if (ctx.state === 'suspended') ctx.resume().then(flush).catch(console.error);
    else flush();
  }
  prebuffer = [];
  playbackStarted = false;
  audioBuffering.set(false);
  nextPlayTime = 0;
}
