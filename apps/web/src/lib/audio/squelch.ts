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

  // Loud warning: two short blips then one long alarm — "beep beep BEEEEEP"
  const schedule = [
    { offset: 0,    dur: 0.11 },
    { offset: 0.17, dur: 0.11 },
    { offset: 0.34, dur: 0.60 },
  ];

  for (const { offset, dur } of schedule) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 880;
    osc.type = 'sine';
    osc.connect(gain);
    gain.connect(ctx.destination);

    const t = ctx.currentTime + offset;
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.6, t + 0.02);
    gain.gain.setValueAtTime(0.6, t + dur - 0.05);
    gain.gain.linearRampToValueAtTime(0, t + dur);
    osc.start(t);
    osc.stop(t + dur + 0.01);
  }
}

export function playTextBeep(): void {
  const ctx = getCtx();
  if (ctx.state !== 'running') return;

  // Soft two-tone ding — incoming text message
  const tones = [1200, 1600];
  tones.forEach((freq, i) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = freq;
    osc.type = 'sine';
    osc.connect(gain);
    gain.connect(ctx.destination);

    const t = ctx.currentTime + i * 0.09;
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.18, t + 0.01);
    gain.gain.linearRampToValueAtTime(0, t + 0.08);
    osc.start(t);
    osc.stop(t + 0.09);
  });
}

export function getAudioContext(): AudioContext | null {
  return audioCtx;
}
