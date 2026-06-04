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
  const chunks = incomingBuffer.splice(0);

  if (typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported(mimeType)) {
    playViaMediaSource(chunks, mimeType);
  } else {
    playViaAudioContext(chunks, mimeType);
  }
}

// Primary: MediaSource API with sequence mode
// play() is called AFTER endOfStream so data is fully ready
function playViaMediaSource(chunks: ArrayBuffer[], mimeType: string): void {
  console.log(`[relay] MSE playback, ${chunks.length} chunks, type=${mimeType}`);
  const ms = new MediaSource();
  const audio = new Audio();
  const msUrl = URL.createObjectURL(ms);
  audio.src = msUrl;

  ms.addEventListener('sourceopen', () => {
    URL.revokeObjectURL(msUrl);

    let sb: SourceBuffer;
    try {
      sb = ms.addSourceBuffer(mimeType);
      // sequence mode: browser assigns timestamps, ignores MediaRecorder's
      // internal timestamps which can cause "jumped backwards" errors
      sb.mode = 'sequence';
    } catch (e) {
      console.error('[relay] addSourceBuffer failed', e, '— falling back to AudioContext');
      playViaAudioContext(chunks, mimeType);
      return;
    }

    let idx = 0;

    const appendNext = () => {
      if (idx >= chunks.length) {
        // All chunks appended — finalize and start playing
        try { ms.endOfStream(); } catch { /* already ended */ }
        audio.play().catch((e) => {
          console.error('[relay] MSE play() rejected', e);
          // Last resort: AudioContext
          playViaAudioContext(chunks, mimeType);
        });
        return;
      }
      try {
        sb.appendBuffer(chunks[idx++]);
      } catch (e) {
        console.error('[relay] appendBuffer error', e);
        // Skip bad chunk and continue
        appendNext();
      }
    };

    sb.addEventListener('updateend', appendNext);
    sb.addEventListener('error', (e) => {
      console.error('[relay] SourceBuffer error', e);
      playViaAudioContext(chunks, mimeType);
    });

    appendNext();
  }, { once: true });

  audio.addEventListener('error', (e) => console.error('[relay] MSE audio error', e));
}

// Fallback: AudioContext.decodeAudioData — works when MSE is unavailable
let sharedCtx: AudioContext | null = null;
function getAudioContext(): AudioContext {
  if (!sharedCtx || sharedCtx.state === 'closed') {
    sharedCtx = new AudioContext();
  }
  return sharedCtx;
}

async function playViaAudioContext(chunks: ArrayBuffer[], mimeType: string): Promise<void> {
  console.log(`[relay] AudioContext fallback, ${chunks.length} chunks`);
  try {
    const blob = new Blob(chunks, { type: mimeType });
    const arrayBuffer = await blob.arrayBuffer();
    const ctx = getAudioContext();
    if (ctx.state === 'suspended') await ctx.resume();
    const decoded = await ctx.decodeAudioData(arrayBuffer);
    const source = ctx.createBufferSource();
    source.buffer = decoded;
    source.connect(ctx.destination);
    source.start(0);
    console.log('[relay] AudioContext playing');
    source.onended = () => source.disconnect();
  } catch (e) {
    console.error('[relay] AudioContext playback failed', e);
  }
}
