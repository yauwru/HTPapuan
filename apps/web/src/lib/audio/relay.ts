// WebSocket binary audio relay — raw PCM Int16
//
// Two capture modes controlled by the `native` parameter:
//   native = false  (default / Laptop-PC)
//     AudioContext requested at 16 kHz; AudioWorklet resamples if device runs at a
//     higher rate. Bandwidth: ~32 KB/s. May have rare issues on some mobile browsers.
//   native = true   (HP/Tablet mode)
//     AudioContext at device native rate (no sampleRate constraint). AudioWorklet does
//     NOT resample — just int16 conversion. Bandwidth: ~96 KB/s at 48 kHz. Most reliable.
//
// Playback: chunks scheduled immediately on AudioContext timeline.
// Audio routed through a radio bandpass + saturation chain.

const SAMPLE_RATE = 16000;  // target rate for auto/laptop mode
const WORKLET_CHUNK = 512;  // samples per chunk (both modes)
const FALLBACK_BUF = 1024;  // ScriptProcessor input buffer

// ── Sender ──────────────────────────────────────────────
let localStream: MediaStream | null = null;
let txCtx: AudioContext | null = null;
let sourceNode: MediaStreamAudioSourceNode | null = null;
let captureNode: AudioWorkletNode | ScriptProcessorNode | null = null;
let silentOut: GainNode | null = null;

export async function startCapture(
  onChunk: (data: ArrayBuffer) => void,
  native = false,
): Promise<number> {
  if (!localStream) {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
        sampleRate: native ? undefined : SAMPLE_RATE,
      },
      video: false,
    });
  }

  // Always create a fresh AudioContext per PTT press to avoid worklet state
  // issues on mobile (module already loaded → processor not re-initialized).
  txCtx = native
    ? new AudioContext()                              // native: let browser pick its preferred rate
    : new AudioContext({ sampleRate: SAMPLE_RATE });  // auto: request 16 kHz

  if (txCtx.state === 'suspended') await txCtx.resume();

  // targetRate tells the worklet whether to resample:
  //   SAMPLE_RATE → resample to 16 kHz (auto mode)
  //   0           → no resample, output at native sampleRate (native mode)
  const targetRate = native ? 0 : SAMPLE_RATE;
  // Actual transmitted PCM sample rate
  const txRate = native ? txCtx.sampleRate : SAMPLE_RATE;

  sourceNode = txCtx.createMediaStreamSource(localStream);
  silentOut = txCtx.createGain();
  silentOut.gain.value = 0;

  let usingWorklet = false;
  try {
    await txCtx.audioWorklet.addModule('/audio-capture-processor.js');
    const wn = new AudioWorkletNode(txCtx, 'audio-capture-processor', {
      processorOptions: { chunkSize: WORKLET_CHUNK, targetRate },
    });
    wn.port.onmessage = (e) => {
      if (e.data instanceof ArrayBuffer) onChunk(e.data);
    };
    captureNode = wn;
    usingWorklet = true;
  } catch {
    // Fallback: ScriptProcessorNode with correct rate detection
    const track = localStream.getAudioTracks()[0];
    const nativeRate = track?.getSettings().sampleRate ?? txCtx.sampleRate;
    const ratio = native ? 1 : (nativeRate / SAMPLE_RATE);
    const sp = txCtx.createScriptProcessor(FALLBACK_BUF, 1, 1);
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

  console.log(`[relay] TX ${native ? 'native' : 'auto'} mode via ${usingWorklet ? 'AudioWorklet' : 'ScriptProcessor'} @ ${txCtx.sampleRate}Hz → ${txRate}Hz`);
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
// Each chunk is scheduled immediately on the AudioContext timeline.
// Audio routed through a radio bandpass + saturation chain for HT character.

let rxCtx: AudioContext | null = null;
let rxChainInput: AudioNode | null = null;
let nextPlayTime = 0;
let incomingSampleRate = SAMPLE_RATE;

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
}

export function receiveChunk(data: ArrayBuffer): void {
  const i16 = new Int16Array(data);
  const f32 = new Float32Array(i16.length);
  for (let i = 0; i < i16.length; i++) {
    f32[i] = i16[i] / 32768;
  }

  const { ctx, input } = getOrCreateRxCtx();

  const schedule = () => {
    const now = ctx.currentTime;

    if (nextPlayTime < now - 0.15) nextPlayTime = 0;

    const startAt = Math.max(now + 0.01, nextPlayTime);
    const buf = ctx.createBuffer(1, f32.length, incomingSampleRate);
    buf.copyToChannel(f32, 0);

    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(input);
    src.start(startAt);
    src.onended = () => src.disconnect();

    nextPlayTime = startAt + buf.duration;
  };

  if (ctx.state === 'suspended') {
    ctx.resume().then(schedule).catch(console.error);
  } else {
    schedule();
  }
}

export function playReceived(): void {
  nextPlayTime = 0;
}
