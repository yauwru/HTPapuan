// WebSocket binary audio relay — sender & receiver

const MIME_TYPES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/ogg',
  'audio/mp4',
];

export function getSupportedMimeType(): string {
  return MIME_TYPES.find((t) => MediaRecorder.isTypeSupported(t)) ?? '';
}

// ── Sender ──────────────────────────────────────────────
let mediaRecorder: MediaRecorder | null = null;
let localStream: MediaStream | null = null;

export async function startCapture(
  onChunk: (data: ArrayBuffer) => void,
): Promise<void> {
  console.log('[relay] startCapture');
  if (!localStream) {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
        sampleRate: 16000,
      },
      video: false,
    });
  }

  const mimeType = getSupportedMimeType();
  mediaRecorder = new MediaRecorder(localStream, {
    mimeType: mimeType || undefined,
    audioBitsPerSecond: 16000,
  });

  mediaRecorder.ondataavailable = async (event) => {
    if (event.data.size > 0) {
      const buffer = await event.data.arrayBuffer();
      console.log(`[relay] sending chunk ${buffer.byteLength}B`);
      onChunk(buffer);
    }
  };

  console.log(`[relay] recording started, mimeType=${mediaRecorder.mimeType}`);
  mediaRecorder.start(250); // 250ms chunks
}

export function stopCapture(): void {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
  mediaRecorder = null;
}

export function releaseStream(): void {
  stopCapture();
  if (localStream) {
    for (const track of localStream.getTracks()) track.stop();
    localStream = null;
  }
}

// ── Receiver ─────────────────────────────────────────────
// Buffer chunks between speaker_start → speaker_end, then play combined
let incomingBuffer: ArrayBuffer[] = [];
let activeMimeType = '';

export function beginReceiving(mimeType: string): void {
  console.log(`[relay] beginReceiving mimeType=${mimeType}`);
  incomingBuffer = [];
  activeMimeType = mimeType;
}

export function receiveChunk(data: ArrayBuffer): void {
  console.log(`[relay] receiveChunk ${data.byteLength}B`);
  incomingBuffer.push(data);
}

export function playReceived(): void {
  console.log(`[relay] playReceived chunks=${incomingBuffer.length}`);
  if (incomingBuffer.length === 0) return;

  const mimeType = activeMimeType || getSupportedMimeType() || 'audio/webm';
  const blob = new Blob(incomingBuffer, { type: mimeType });
  incomingBuffer = [];

  console.log(`[relay] playing blob size=${blob.size} type=${mimeType}`);
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  audio.onended = () => URL.revokeObjectURL(url);
  audio.onerror = (e) => { console.error('[relay] audio error', e); URL.revokeObjectURL(url); };
  audio.play().catch((e) => { console.error('[relay] play() rejected', e); URL.revokeObjectURL(url); });
}
