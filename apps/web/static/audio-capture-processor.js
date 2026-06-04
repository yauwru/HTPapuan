// AudioWorklet processor — runs on the audio rendering thread.
// Resamples from the device's native rate down to TARGET_RATE (16 kHz) using
// linear interpolation, then posts Int16 PCM chunks to the main thread.
// This ensures transmitted audio is always 16 kHz regardless of device sample rate
// (mobile devices often run at 44100 or 48000 Hz, ignoring the requested 16 kHz).
const TARGET_RATE = 16000;

class AudioCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    // sampleRate is the AudioContext's actual rate (may differ from requested 16 kHz)
    this._ratio    = sampleRate / TARGET_RATE;                          // e.g. 3.0 for 48kHz→16kHz
    this._chunkOut = (options.processorOptions || {}).chunkSize || 512; // output samples @ 16 kHz
    this._chunkIn  = Math.round(this._chunkOut * this._ratio);          // input samples per chunk
    this._buf      = new Float32Array(this._chunkIn + 512);             // ring buffer with headroom
    this._filled   = 0;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;

    if (this._filled + channel.length > this._buf.length) {
      const grown = new Float32Array(this._buf.length * 2);
      grown.set(this._buf.subarray(0, this._filled));
      this._buf = grown;
    }
    this._buf.set(channel, this._filled);
    this._filled += channel.length;

    while (this._filled >= this._chunkIn) {
      // Linear-interpolation downsample: _chunkIn input → _chunkOut output
      const i16 = new Int16Array(this._chunkOut);
      for (let i = 0; i < this._chunkOut; i++) {
        const pos  = i * this._ratio;
        const lo   = Math.floor(pos);
        const hi   = Math.min(lo + 1, this._chunkIn - 1);
        const frac = pos - lo;
        const s    = Math.max(-1, Math.min(1, this._buf[lo] * (1 - frac) + this._buf[hi] * frac));
        i16[i] = s < 0 ? s * 32768 : s * 32767;
      }
      // Transfer ownership — zero-copy across thread boundary
      this.port.postMessage(i16.buffer, [i16.buffer]);

      // Slide ring buffer: discard the consumed input samples
      this._buf.copyWithin(0, this._chunkIn);
      this._filled -= this._chunkIn;
    }

    return true;
  }
}

registerProcessor('audio-capture-processor', AudioCaptureProcessor);
