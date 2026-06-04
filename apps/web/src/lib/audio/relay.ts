// WebSocket binary audio relay — raw PCM Int16 @ 16 kHz
//
// MediaRecorder WebM output is a live-streaming format (no seek index,
// unbounded Segment) that neither <audio> blob URLs nor AudioContext
// decodeAudioData() can reliably decode across browsers/OS combos.
// Raw Int16 PCM avoids all codec negotiation and container issues.

const SAMPLE_RATE = 16000;
const SCRIPT_BUFFER = 2048; // ~128 ms per chunk at 16 kHz → 4 096 bytes/chunk

// ── Sender ──────────────────────────────────────────────
let localStream: MediaStream | null = null;
let txCtx: AudioContext | null = null;
let sourceNode: MediaStreamAudioSourceNode | null = null;
let processor: ScriptProcessorNode | null = null;
let silentOut: GainNode | null = null;

export async function startCapture(
  onChunk: (data: ArrayBuffer) => void,
): Promise<void> {
  console.log('[relay] startCapture (PCM)');

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
  processor  = txCtx.createScriptProcessor(SCRIPT_BUFFER, 1, 1);
  silentOut  = txCtx.createGain();
  silentOut.gain.value = 0; // capture only — no local playback

  processor.onaudioprocess = (e) => {
    const f32 = e.inputBuffer.getChannelData(0);
    const i16 = new Int16Array(f32.length);
    for (let i = 0; i < f32.length; i++) {
      const s = Math.max(-1, Math.min(1, f32[i]));
      i16[i] = s < 0 ? s * 32768 : s * 32767;
    }
    console.log(`[relay] sending PCM chunk ${i16.byteLength}B`);
    onChunk(i16.buffer);
  };

  sourceNode.connect(processor);
  processor.connect(silentOut);
  silentOut.connect(txCtx.destination);

  console.log(`[relay] PCM capture started @ ${txCtx.sampleRate} Hz`);
}

export function stopCapture(): void {
  processor?.disconnect();
  sourceNode?.disconnect();
  silentOut?.disconnect();
  processor = sourceNode = silentOut = null;
  console.log('[relay] capture stopped');
}

export function releaseStream(): void {
  stopCapture();
  localStream?.getTracks().forEach((t) => t.stop());
  localStream = null;
  txCtx?.close();
  txCtx = null;
}

// Kept for protocol compatibility — PCM mode doesn't need a MIME type
export function getSupportedMimeType(): string {
  return '';
}

// ── Receiver ─────────────────────────────────────────────
let incomingChunks: Int16Array[] = [];
let rxCtx: AudioContext | null = null;

function getRxCtx(): AudioContext {
  if (!rxCtx || rxCtx.state === 'closed') {
    rxCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
  }
  return rxCtx;
}

export function beginReceiving(_mimeType: string): void {
  console.log('[relay] beginReceiving (PCM)');
  incomingChunks = [];
}

export function receiveChunk(data: ArrayBuffer): void {
  console.log(`[relay] receiveChunk ${data.byteLength}B`);
  incomingChunks.push(new Int16Array(data));
}

export function playReceived(): void {
  console.log(`[relay] playReceived chunks=${incomingChunks.length}`);
  if (incomingChunks.length === 0) return;

  const totalSamples = incomingChunks.reduce((s, a) => s + a.length, 0);
  const f32 = new Float32Array(totalSamples);
  let off = 0;
  for (const chunk of incomingChunks) {
    for (let i = 0; i < chunk.length; i++) {
      f32[off++] = chunk[i] / 32768;
    }
  }
  incomingChunks = [];

  const ctx = getRxCtx();

  const doPlay = () => {
    const buf = ctx.createBuffer(1, f32.length, SAMPLE_RATE);
    buf.copyToChannel(f32, 0);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    src.start(0);
    console.log(`[relay] playing ${f32.length} PCM samples`);
    src.onended = () => src.disconnect();
  };

  if (ctx.state === 'suspended') {
    ctx.resume().then(doPlay).catch((e) => console.error('[relay] resume failed', e));
  } else {
    doPlay();
  }
}
