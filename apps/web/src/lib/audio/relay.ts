// WebSocket binary audio relay — raw PCM Int16 @ 16 kHz
//
// Capture: AudioWorklet resamples from device native rate → 16 kHz before sending.
//          Fallback to ScriptProcessorNode also resamples to 16 kHz.
//          Transmitted PCM is always 16 kHz regardless of sender device.
// Playback: chunks scheduled immediately on AudioContext timeline.
//           Audio routed through a radio bandpass + saturation chain.

const SAMPLE_RATE = 16000;
const WORKLET_CHUNK = 512;  // output samples @ 16 kHz = 32 ms per chunk
const FALLBACK_BUF = 1024;  // ScriptProcessor input buffer size

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

  if (!txCtx || txCtx.state === 'closed') {
    txCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
  }
  if (txCtx.state === 'suspended') await txCtx.resume();

  sourceNode = txCtx.createMediaStreamSource(localStream);
  silentOut = txCtx.createGain();
  silentOut.gain.value = 0;

  let usingWorklet = false;
  try {
    await txCtx.audioWorklet.addModule('/audio-capture-processor.js');
    const wn = new AudioWorkletNode(txCtx, 'audio-capture-processor', {
      processorOptions: { chunkSize: WORKLET_CHUNK },
    });
    wn.port.onmessage = (e) => onChunk(e.data as ArrayBuffer);
    captureNode = wn;
    usingWorklet = true;
  } catch {
    // AudioWorklet unavailable — ScriptProcessorNode with manual resampling to 16 kHz
    const nativeRate = txCtx.sampleRate;
    const ratio = nativeRate / SAMPLE_RATE;
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

  console.log(`[relay] capture @ ${txCtx.sampleRate}Hz via ${usingWorklet ? 'AudioWorklet' : 'ScriptProcessor'} → resampled to ${SAMPLE_RATE}Hz`);
  // Worklet resamples to 16 kHz internally — transmitted PCM is always SAMPLE_RATE
  return SAMPLE_RATE;
}

export function stopCapture(): void {
  captureNode?.disconnect();
  sourceNode?.disconnect();
  silentOut?.disconnect();
  if (captureNode instanceof AudioWorkletNode) captureNode.port.close();
  captureNode = sourceNode = silentOut = null;
}

export function releaseStream(): void {
  stopCapture();
  localStream?.getTracks().forEach((t) => t.stop());
  localStream = null;
  txCtx?.close();
  txCtx = null;
}

export function getSupportedMimeType(): string {
  return '';
}

// ── Receiver ─────────────────────────────────────────────
// Each incoming chunk is scheduled on the AudioContext timeline immediately.
// Audio passes through a radio processing chain: bandpass (300–3400 Hz) + soft
// saturation + compression — gives the classic HT / CB radio character.

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

    // Bandpass: telephone/radio range 300–3400 Hz
    const hp = rxCtx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 300;
    hp.Q.value = 0.9;

    const lp = rxCtx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 3400;
    lp.Q.value = 0.9;

    // Soft saturation — adds the characteristic "crunch" of analogue radio
    const ws = rxCtx.createWaveShaper();
    ws.curve = makeDistortionCurve(40);
    ws.oversample = '2x';

    // Compensate for gain reduction from bandpass + clipper
    const gain = rxCtx.createGain();
    gain.gain.value = 2.2;

    // Light compression to keep volume consistent
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

    // Resync if we fell behind by >150 ms (tab hidden, etc.)
    if (nextPlayTime < now - 0.15) nextPlayTime = 0;

    const startAt = Math.max(now + 0.01, nextPlayTime);
    const buf = ctx.createBuffer(1, f32.length, incomingSampleRate);
    buf.copyToChannel(f32, 0);

    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(input);  // route through radio chain
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
