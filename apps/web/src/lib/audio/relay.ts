// WebSocket binary audio relay — raw PCM Int16 @ 16 kHz
//
// Capture: fresh AudioContext per PTT press to avoid worklet re-init issues on mobile.
//          AudioWorklet resamples from device native rate → 16 kHz (linear interp).
//          ScriptProcessorNode fallback also resamples to 16 kHz.
// Playback: jitter buffer (PREBUFFER_CHUNKS × 32 ms ≈ 128 ms) before scheduling,
//           so moderate network jitter does not cause gaps.
//           Audio routed through a radio bandpass + saturation chain.
//           Chunks are discarded while the tab is hidden; buffer resets on return
//           so stale audio cannot burst-play and collide when the user comes back.

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
  if (!localStream) {
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
  }

  // Always create a fresh AudioContext per PTT press — avoids worklet re-init
  // issues on mobile where addModule on a reused context silently falls back.
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
    // Fallback: ScriptProcessorNode, resample to SAMPLE_RATE using true hardware rate
    const track    = localStream.getAudioTracks()[0];
    const hwRate   = track?.getSettings().sampleRate ?? txCtx.sampleRate;
    const ratio    = hwRate / SAMPLE_RATE;
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
}

export function releaseStream(): void {
  stopCapture();
  localStream?.getTracks().forEach((t) => t.stop());
  localStream = null;
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
// Track tab visibility — discard chunks while hidden to prevent burst on return
let tabHidden = false;

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    tabHidden = document.hidden;
    if (document.hidden) {
      // Reset receive state — stale audio must not burst-play when returning
      prebuffer = [];
      playbackStarted = false;
      nextPlayTime = 0;
      audioBuffering.set(false);
    }
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
  // Discard while tab is hidden — prevents stale burst on return
  if (tabHidden) return;

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
