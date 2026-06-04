// AudioWorklet processor — runs on the audio rendering thread, not the main thread.
// Accumulates 128-sample blocks from the Web Audio engine into CHUNK_SAMPLES-sized
// chunks, converts Float32 → Int16, then posts to the main thread via port.
class AudioCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this._target = (options.processorOptions || {}).chunkSize || 512;
    this._buf = [];
    this._count = 0;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;

    // Copy — inputs are neutered after process() returns
    this._buf.push(new Float32Array(channel));
    this._count += channel.length;

    if (this._count >= this._target) {
      const i16 = new Int16Array(this._count);
      let off = 0;
      for (const b of this._buf) {
        for (let i = 0; i < b.length; i++) {
          const s = Math.max(-1, Math.min(1, b[i]));
          i16[off++] = s < 0 ? s * 32768 : s * 32767;
        }
      }
      // Transfer ownership — zero-copy across the thread boundary
      this.port.postMessage(i16.buffer, [i16.buffer]);
      this._buf = [];
      this._count = 0;
    }

    return true; // keep processor alive
  }
}

registerProcessor('audio-capture-processor', AudioCaptureProcessor);
