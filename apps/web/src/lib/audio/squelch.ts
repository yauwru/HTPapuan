let audioCtx: AudioContext | null = null;

function getCtx(): AudioContext {
  if (!audioCtx) {
    audioCtx = new AudioContext({ sampleRate: 8000 });
  }
  return audioCtx;
}

export async function resumeAudio(): Promise<void> {
  const ctx = getCtx();
  if (ctx.state === 'suspended') await ctx.resume();
}

function generateNoise(ctx: AudioContext, duration: number, fadeIn: boolean): AudioBuffer {
  const frames = Math.floor(ctx.sampleRate * duration);
  const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
  const data = buffer.getChannelData(0);

  for (let i = 0; i < frames; i++) {
    const t = i / frames;
    // White noise with envelope
    const env = fadeIn
      ? Math.min(t * 8, 1) * Math.max(1 - t * 2, 0)   // quick rise, moderate fall
      : Math.min(t * 4, 1) * Math.max(1 - t * 4, 0);   // short burst
    data[i] = (Math.random() * 2 - 1) * env * 0.3;
  }

  return buffer;
}

export function playSquelchOpen(): void {
  const ctx = getCtx();
  if (ctx.state !== 'running') return;

  const buffer = generateNoise(ctx, 0.25, true);
  const source = ctx.createBufferSource();
  source.buffer = buffer;

  const gain = ctx.createGain();
  gain.gain.value = 0.6;

  source.connect(gain);
  gain.connect(ctx.destination);
  source.start();
}

export function playSquelchClose(): void {
  const ctx = getCtx();
  if (ctx.state !== 'running') return;

  const buffer = generateNoise(ctx, 0.15, false);
  const source = ctx.createBufferSource();
  source.buffer = buffer;

  const gain = ctx.createGain();
  gain.gain.value = 0.4;

  source.connect(gain);
  gain.connect(ctx.destination);
  source.start();
}

export function playBusyTone(): void {
  const ctx = getCtx();
  if (ctx.state !== 'running') return;

  // Short double-beep indicating channel busy
  [0, 0.15].forEach((offset) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.frequency.value = 440;
    osc.type = 'sine';
    gain.gain.value = 0;

    osc.connect(gain);
    gain.connect(ctx.destination);

    const start = ctx.currentTime + offset;
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(0.3, start + 0.02);
    gain.gain.linearRampToValueAtTime(0, start + 0.12);

    osc.start(start);
    osc.stop(start + 0.13);
  });
}

export function getAudioContext(): AudioContext | null {
  return audioCtx;
}
