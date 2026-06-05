// WebSocket binary audio relay — raw PCM Int16
//
// Two capture modes:
//   native = false  (Laptop/PC): AudioContext @ 16 kHz, AudioWorklet resamples if needed.
//                                Chunk: 512 samples = 32 ms. Bandwidth: ~32 KB/s.
//   native = true   (HP/Tablet): AudioContext @ device native rate, no resampling.
//                                Chunk: ~32 ms worth of samples at native rate (1536 @ 48 kHz).
//                                Bandwidth: ~96 KB/s. Most reliable on iOS/Android.
//
// Both modes produce ~32 ms chunks — same jitter tolerance regardless of mode.
//
// Playback: chunks pass through a jitter buffer (PREBUFFER_CHUNKS × 32 ms = ~128 ms)
//           before scheduling, so moderate network jitter does not cause gaps.
//           Audio routed through a radio bandpass + saturation chain.

import { writable } from 'svelte/store';

const SAMPLE_RATE = 16000;   // target rate for auto/laptop mode
const CHUNK_MS = 32;         // target chunk duration (ms) for both modes
const FALLBACK_BUF = 1024;

// ── Sender ──────────────────────────────────────────────
let localStream: MediaStream | null = null;
let localStreamNative = false;   // which mode was the stream created for
let txCtx: AudioContext | null = null;
let sourceNode: MediaStreamAudioSourceNode | null = null;
let captureNode: AudioWorkletNode | ScriptProcessorNode | null = null;
let silentOut: GainNode | null = null;

export async function startCapture(
  onChunk: (data: ArrayBuffer) => void,
  native = false,
): Promise<number> {
  // Release stream if mode changed — different constraint applies
  if (localStream && localStreamNative !== native) {
    localStream.getTracks().forEach((t) => t.stop());
    localStream = null;
  }

  if (!localStream) {
    const audioConstraints: MediaTrackConstraints = {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
    };
    if (!native) audioConstraints.sampleRate = SAMPLE_RATE;

    localStream = await navigator.mediaDevices.getUserMedia({
      audio: audioConstraints,
      video: false,
    });
    localStreamNative = native;
  }

  // Fresh AudioContext per PTT press to avoid worklet re-init issues on mobile
  txCtx = native
    ? new AudioContext()
    : new AudioContext({ sampleRate: SAMPLE_RATE });

  if (txCtx.state === 'suspended') await txCtx.resume();

  const nativeRate = txCtx.sampleRate;
  // Chunk size: always target CHUNK_MS ms worth of output samples
  // auto: 512 @ 16 kHz = 32 ms   native: 1536 @ 48 kHz = 32 ms
  const chunkOut = native
    ? Math.round((CHUNK_MS / 1000) * nativeRate)
    : Math.round((CHUNK_MS / 1000) * SAMPLE_RATE);
  // targetRate = 0 → no resample (native); SAMPLE_RATE → resample to 16 kHz
  const targetRate = native ? 0 : SAMPLE_RATE;
  // Actual transmitted PCM rate
  const txRate = native ? nativeRate : SAMPLE_RATE;

  sourceNode = txCtx.createMediaStreamSource(localStream);
  silentOut = txCtx.createGain();
  silentOut.gain.value = 0;

  let usingWorklet = false;
  try {
    await txCtx.audioWorklet.addModule('/audio-capture-processor.js');
    const wn = new AudioWorkletNode(txCtx, 'audio-capture-processor', {
      processorOptions: { chunkSize: chunkOut, targetRate },
    });
    wn.port.onmessage = (e) => {
      if (e.data instanceof ArrayBuffer) onChunk(e.data);
    };
    captureNode = wn;
    usingWorklet = true;
  } catch {
    // Fallback: ScriptProcessorNode with correct rate from track settings
    const track = localStream.getAudioTracks()[0];
    const hwRate = track?.getSettings().sampleRate ?? nativeRate;
    const ratio = native ? 1 : (hwRate / SAMPLE_RATE);
    const spBuf = Math.max(256, Math.pow(2, Math.round(Math.log2((CHUNK_MS / 1000) * hwRate))));
    const sp = txCtx.createScriptProcessor(spBuf, 1, 1);
    sp.onaudioprocess = (e) => {
      const f32 = e.inputBuffer.getChannelData(0);
      const outLen = Math.floor(f32.length / ratio);
      const i16 = new Int16Array(outLen);
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

  console.log(`[relay] TX ${native ? 'native' : 'auto'} via ${usingWorklet ? 'AudioWorklet' : 'ScriptProcessor'} @ ${nativeRate}Hz, chunk=${chunkOut}smp=${CHUNK_MS}ms → ${txRate}Hz`);
  return txRate;
}

export function stopCapture(): void {
  captureNode?.disconnect();
  sourceNode?.disconnect();
  silentOut?.disconnect();
  if (captureNode instanceof AudioWorkletNode) captureNode.port.close();
  captureNode = sourceNode = silentOut = null;
  txCtx?.close();
  txCtx = null;
  // Stream is kept alive between PTT presses (same mode reuses mic without re-prompting)
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
// Chunks fill a prebuffer before playback starts.  Once the buffer reaches
// PREBUFFER_CHUNKS the queued audio is scheduled in one burst; subsequent
// chunks are scheduled immediately.  This absorbs up to
// (PREBUFFER_CHUNKS × chunk_duration) of network jitter without gaps.
//
// Audio routed through a radio bandpass + saturation chain for HT character.

// Number of chunks to buffer before starting playback (~128 ms at 32 ms/chunk)
const PREBUFFER_CHUNKS = 4;

// Exported store — true while the jitter buffer is filling (visible in UI)
export const audioBuffering = writable(false);

let rxCtx: AudioContext | null = null;
let rxChainInput: AudioNode | null = null;
let nextPlayTime = 0;
let incomingSampleRate = SAMPLE_RATE;
let prebuffer: Float32Array[] = [];
let playbackStarted = false;

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
  // Resync if we fell behind by >200 ms (e.g. tab was hidden, or buffer just started)
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
      if (prebuffer.length >= PREBUFFER_CHUNKS) {
        // Buffer full — flush and start playing
        playbackStarted = true;
        audioBuffering.set(false);
        for (const chunk of prebuffer) scheduleChunk(chunk, ctx, input);
        prebuffer = [];
      }
      // else: still filling the prebuffer
    } else {
      // Already playing — schedule this chunk immediately
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
  // Transmission ended — flush any remaining prebuffer chunks
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
