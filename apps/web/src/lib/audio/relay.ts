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
// Buffer chunks between speaker_start → speaker_end, then play via MediaSource
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

  const mimeType = activeMimeType || getSupportedMimeType() || 'audio/webm;codecs=opus';
  const chunks = incomingBuffer.splice(0); // take all chunks and clear buffer

  console.log(`[relay] playing via MSE, ${chunks.length} chunks, mimeType=${mimeType}`);

  // MediaRecorder produces a streaming WebM — must use MediaSource API to play it.
  // new Audio(blobUrl) fails with NotSupportedError because the WebM lacks
  // seekable index metadata that <audio> requires for file playback.
  if (typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported(mimeType)) {
    playViaMediaSource(chunks, mimeType);
  } else {
    // Fallback for browsers without MSE support (e.g. older iOS Safari)
    playViaBlob(chunks, mimeType);
  }
}

function playViaMediaSource(chunks: ArrayBuffer[], mimeType: string): void {
  const ms = new MediaSource();
  const audio = new Audio();
  const msUrl = URL.createObjectURL(ms);
  audio.src = msUrl;

  ms.addEventListener('sourceopen', () => {
    URL.revokeObjectURL(msUrl); // URL no longer needed once attached

    let sb: SourceBuffer;
    try {
      sb = ms.addSourceBuffer(mimeType);
    } catch (e) {
      console.error('[relay] addSourceBuffer failed', e);
      ms.endOfStream('decode');
      return;
    }

    let idx = 0;

    const appendNext = () => {
      if (idx >= chunks.length) {
        try { ms.endOfStream(); } catch { /* already ended */ }
        return;
      }
      try {
        sb.appendBuffer(chunks[idx++]);
      } catch (e) {
        console.error('[relay] appendBuffer failed', e);
      }
    };

    sb.addEventListener('updateend', appendNext);
    sb.addEventListener('error', (e) => console.error('[relay] SourceBuffer error', e));

    appendNext();
  }, { once: true });

  audio.addEventListener('error', (e) => console.error('[relay] MSE audio error', e));
  audio.play().catch((e) => console.error('[relay] MSE play() rejected', e));
}

function playViaBlob(chunks: ArrayBuffer[], mimeType: string): void {
  const blob = new Blob(chunks, { type: mimeType });
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  audio.onended = () => URL.revokeObjectURL(url);
  audio.onerror = (e) => { console.error('[relay] blob audio error', e); URL.revokeObjectURL(url); };
  audio.play().catch((e) => { console.error('[relay] blob play() rejected', e); URL.revokeObjectURL(url); });
}
