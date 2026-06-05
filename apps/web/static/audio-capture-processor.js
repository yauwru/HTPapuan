// AudioWorklet processor — runs on the audio rendering thread.
//
// targetRate option controls resampling:
//   targetRate > 0  → resample from native sampleRate to targetRate (e.g. 16000)
//   targetRate = 0  → no resampling; output at native sampleRate (HP/Tablet mode)
//
// Uses linear interpolation for downsampling. Output is Int16 PCM.
class AudioCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = options.processorOptions || {};
    // 0 or missing = native mode (no resample)
    const target  = (opts.targetRate > 0) ? opts.targetRate : sampleRate;
    this._ratio    = sampleRate / target;             // e.g. 3.0 for 48kHz→16kHz; 1.0 for native
    this._chunkOut = opts.chunkSize || 512;           // output samples per chunk
    this._chunkIn  = Math.round(this._chunkOut * this._ratio); // input samples to collect
    this._buf      = new Float32Array(this._chunkIn + 512);
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
      const i16 = new Int16Array(this._chunkOut);

      if (this._ratio === 1) {
        // Native mode — direct float32→int16, no resampling
        for (let i = 0; i < this._chunkOut; i++) {
          const s = Math.max(-1, Math.min(1, this._buf[i]));
          i16[i] = s < 0 ? s * 32768 : s * 32767;
        }
      } else {
        // Resample: linear interpolation downsample
        for (let i = 0; i < this._chunkOut; i++) {
          const pos  = i * this._ratio;
          const lo   = Math.floor(pos);
          const hi   = Math.min(lo + 1, this._chunkIn - 1);
          const frac = pos - lo;
          const s    = Math.max(-1, Math.min(1, this._buf[lo] * (1 - frac) + this._buf[hi] * frac));
          i16[i] = s < 0 ? s * 32768 : s * 32767;
        }
      }

      // Zero-copy transfer to main thread
      this.port.postMessage(i16.buffer, [i16.buffer]);

      this._buf.copyWithin(0, this._chunkIn);
      this._filled -= this._chunkIn;
    }

    return true;
  }
}

registerProcessor('audio-capture-processor', AudioCaptureProcessor);
