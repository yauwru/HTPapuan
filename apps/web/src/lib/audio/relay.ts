// WebSocket binary audio relay — raw PCM Int16 @ 16 kHz
//
// Capture: AudioWorklet (audio thread) → no main-thread glitches on mobile.
//          Falls back to ScriptProcessorNode if AudioWorklet unavailable.
// Transport: Int16 PCM binary frames — no codec/container issues.
// Playback: each incoming chunk scheduled immediately on AudioContext timeline
//           so audio starts within one network RTT, not after PTT release.

const SAMPLE_RATE = 16000;
const WORKLET_CHUNK = 512;  // samples per chunk = 32 ms at 16 kHz, 1 024 bytes
const FALLBACK_BUF = 1024;  // ScriptProcessor buffer (64 ms) — used only if Worklet fails

// ── Sender ──────────────────────────────────────────────
let localStream: MediaStream | null = null;
let txCtx: AudioContext | null = null;
let sourceNode: MediaStreamAudioSourceNode | null = null;
let captureNode: AudioWorkletNode | ScriptProcessorNode | null = null;
let silentOut: GainNode | null = null;

export async function startCapture(
  onChunk: (data: ArrayBuffer) => void,
): Promise<void> {
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
  silentOut.gain.value = 0; // capture only — no local echo

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
    // AudioWorklet unavailable — fall back to (deprecated) ScriptProcessorNode
    const sp = txCtx.createScriptProcessor(FALLBACK_BUF, 1, 1);
    sp.onaudioprocess = (e) => {
      const f32 = e.inputBuffer.getChannelData(0);
      const i16 = new Int16Array(f32.length);
      for (let i = 0; i < f32.length; i++) {
        const s = Math.max(-1, Math.min(1, f32[i]));
        i16[i] = s < 0 ? s * 32768 : s * 32767;
      }
      onChunk(i16.buffer);
    };
    captureNode = sp;
  }

  sourceNode.connect(captureNode);
  captureNode.connect(silentOut);   // must reach destination for processing to run
  silentOut.connect(txCtx.destination);

  console.log(`[relay] capture started via ${usingWorklet ? 'AudioWorklet' : 'ScriptProcessor'} @ ${txCtx.sampleRate} Hz`);
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

// Kept for protocol compatibility — PCM transport doesn't need a MIME type
export function getSupportedMimeType(): string {
  return '';
}

// ── Receiver ─────────────────────────────────────────────
// Each incoming chunk is scheduled on the AudioContext timeline immediately.
// AudioContext.currentTime is the precise clock; chunks play back-to-back
// without gaps or the full-transmission delay of the old buffer-then-play approach.

let rxCtx: AudioContext | null = null;
let nextPlayTime = 0;

function getRxCtx(): AudioContext {
  if (!rxCtx || rxCtx.state === 'closed') {
    rxCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
  }
  return rxCtx;
}

export function beginReceiving(_mimeType: string): void {
  nextPlayTime = 0;
}

export function receiveChunk(data: ArrayBuffer): void {
  const i16 = new Int16Array(data);
  const f32 = new Float32Array(i16.length);
  for (let i = 0; i < i16.length; i++) {
    f32[i] = i16[i] / 32768;
  }

  const ctx = getRxCtx();

  const schedule = () => {
    const now = ctx.currentTime;

    // If we fell behind by >150 ms (e.g. tab was hidden), resync to now
    if (nextPlayTime < now - 0.15) nextPlayTime = 0;

    const startAt = Math.max(now + 0.01, nextPlayTime);
    const buf = ctx.createBuffer(1, f32.length, SAMPLE_RATE);
    buf.copyToChannel(f32, 0);

    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
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
  // Streaming mode: chunks already scheduled — reset for next transmission
  nextPlayTime = 0;
}
