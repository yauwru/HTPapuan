// WebSocket binary audio relay — raw PCM Int16 @ 16 kHz
//
// Capture: txCtx persists between PTT presses — only getUserMedia is renewed each time.
//          Reusing MediaStreamTrack across *different* AudioContext instances causes
//          slowmo on iOS; reusing the same ctx + fresh stream avoids it.
//          AudioWorklet resamples native rate → 16 kHz via linear interpolation.
//          ScriptProcessorNode fallback uses txCtx.sampleRate (actual rate) —
//          NOT track.getSettings().sampleRate, which iOS reports as the requested value.
//
// Playback: 3-chunk prebuffer (≈48 ms) then web-audio clock scheduling.
//           LOOK_AHEAD ensures each chunk is always scheduled slightly ahead of now.
//           nextPlayTime is NOT reset between transmissions so consecutive speakers
//           chain without a re-buffer delay.

import { writable } from 'svelte/store';

const SAMPLE_RATE      = 16000;
const WORKLET_CHUNK    = 256;   // 16 ms @ 16 kHz — halved from 512 (32 ms)
const FALLBACK_BUF     = 512;
const PREBUFFER_CHUNKS = 3;     // 48 ms prebuffer — was 4 × 32 ms = 128 ms
const LOOK_AHEAD       = 0.06;  // 60 ms scheduling look-ahead
const STALE_S          = 0.5;   // reset playhead when >500 ms behind

// ── Sender ──────────────────────────────────────────────

let localStream: MediaStream | null = null;
// txCtx and workletLoaded persist across PTT presses — avoids re-init overhead
let txCtx: AudioContext | null = null;
let workletLoaded = false;
let sourceNode: MediaStreamAudioSourceNode | null = null;
let captureNode: AudioWorkletNode | ScriptProcessorNode | null = null;
let silentOut: GainNode | null = null;

async function ensureTxCtx(): Promise<void> {
  if (!txCtx || txCtx.state === 'closed') {
    txCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
    workletLoaded = false;
  }
  if (txCtx.state === 'suspended') await txCtx.resume();
  if (!workletLoaded) {
    try {
      await txCtx.audioWorklet.addModule('/audio-capture-processor.js');
      workletLoaded = true;
    } catch {
      // ScriptProcessorNode fallback below
    }
  }
}

function disconnectCaptureGraph(): void {
  if (captureNode instanceof AudioWorkletNode) captureNode.port.onmessage = null;
  captureNode?.disconnect();
  sourceNode?.disconnect();
  silentOut?.disconnect();
  captureNode = sourceNode = silentOut = null;
}

export async function startCapture(
  onChunk: (data: ArrayBuffer) => void,
): Promise<number> {
  disconnectCaptureGraph();

  // Always get a fresh stream — prevents iOS track-state degradation across captures
  localStream?.getTracks().forEach((t) => t.stop());
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

  // Reuse existing AudioContext — creating a new one each press adds 100-200 ms on mobile
  await ensureTxCtx();

  sourceNode = txCtx!.createMediaStreamSource(localStream);
  silentOut  = txCtx!.createGain();
  silentOut.gain.value = 0;

  let usingWorklet = false;
  if (workletLoaded) {
    try {
      const wn = new AudioWorkletNode(txCtx!, 'audio-capture-processor', {
        processorOptions: { chunkSize: WORKLET_CHUNK, targetRate: SAMPLE_RATE },
      });
      wn.port.onmessage = (e) => {
        if (e.data instanceof ArrayBuffer) onChunk(e.data);
      };
      captureNode = wn;
      usingWorklet = true;
    } catch {
      workletLoaded = false;
    }
  }

  if (!usingWorklet) {
    // ScriptProcessorNode fallback.
    // txCtx.sampleRate = ACTUAL device rate (iOS ignores the 16 kHz request).
    // Using track.getSettings().sampleRate would return the *requested* 16 kHz
    // → ratio 1.0 → no resampling → 3× slowmo on mobile.
    const ratio = txCtx!.sampleRate / SAMPLE_RATE;
    const sp = txCtx!.createScriptProcessor(FALLBACK_BUF, 1, 1);
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
  silentOut.connect(txCtx!.destination);

  console.log(`[relay] TX ${usingWorklet ? 'AudioWorklet' : 'ScriptProcessor'} @ ${txCtx!.sampleRate}Hz→${SAMPLE_RATE}Hz`);
  return SAMPLE_RATE;
}

export function stopCapture(): void {
  disconnectCaptureGraph();
  // Stop the stream — fresh getUserMedia next press avoids iOS track-state degradation.
  // txCtx is kept alive intentionally so the next press skips re-init.
  localStream?.getTracks().forEach((t) => t.stop());
  localStream = null;
}

export function releaseStream(): void {
  stopCapture();
}

export async function requestMicPermission(): Promise<void> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices) return;
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    s.getTracks().forEach((t) => t.stop());
    // Pre-init AudioContext + worklet so the very first PTT press has no setup delay
    await ensureTxCtx();
  } catch {
    // Denied or unavailable — PTT will surface the error when pressed
  }
}

export function getSupportedMimeType(): string {
  return '';
}

// ── Receiver ─────────────────────────────────────────────

export const audioBuffering = writable(false);

let rxCtx: AudioContext | null = null;
let rxChainInput: AudioNode | null = null;
// nextPlayTime is NOT reset between speaker_start/speaker_end so consecutive
// speakers can chain without re-accumulating a full prebuffer.
let nextPlayTime = 0;
let incomingSampleRate = SAMPLE_RATE;
let prebuffer: Float32Array[] = [];
let playbackStarted = false;

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && rxCtx && rxCtx.state === 'suspended') {
      // iOS suspended the RX context while backgrounded — close so next chunk
      // gets a fresh context instead of playing a stale burst.
      rxCtx.close().catch(() => {});
      rxCtx = null;
      rxChainInput = null;
      prebuffer = [];
      playbackStarted = false;
      nextPlayTime = 0;
      audioBuffering.set(false);
    }
    // Going to background: do nothing — allow background audio to keep playing.
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
  prebuffer = [];
  playbackStarted = false;
  audioBuffering.set(true);
  // nextPlayTime intentionally NOT reset — if it's stale, scheduleChunk handles it
}

function scheduleChunk(f32: Float32Array, ctx: AudioContext, input: AudioNode): void {
  const now = ctx.currentTime;
  // If playhead is too far in the past (e.g. long silence or first use), catch up
  if (nextPlayTime < now - STALE_S) {
    nextPlayTime = now + LOOK_AHEAD;
  }
  const startAt = Math.max(now + LOOK_AHEAD, nextPlayTime);
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
      if (prebuffer.length >= PREBUFFER_CHUNKS) {
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
  // Flush any remaining prebuffer so short transmissions still play
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
  // nextPlayTime preserved — next speaker chains without extra prebuffer wait
}
