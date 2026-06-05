import { get } from 'svelte/store';
import { pttState, isInChannel } from './stores/channel.js';
import { send, sendBinary } from './wsClient.js';
import { resumeAudio, playSquelchClose, playBusyTone } from './audio/squelch.js';
import { startCapture, stopCapture } from './audio/relay.js';
import { pttKey } from './stores/pttKey.js';

let isHolding = false;

export async function onPTTDown(event: Event): Promise<void> {
  event.preventDefault();

  if (!get(isInChannel)) return;
  if (isHolding) return;

  const state = get(pttState);
  if (state === 'transmitting') return;

  // Resume AudioContext — this is the required user gesture
  await resumeAudio();

  isHolding = true;
  pttState.set('transmitting');

  try {
    const sampleRate = await startCapture((chunk) => sendBinary(chunk));
    send({ type: 'ptt_start', sampleRate });
  } catch (e) {
    console.error('[PTT] Failed to start capture', e);
    isHolding = false;
    pttState.set('idle');
  }
}

export function onPTTUp(): void {
  if (!isHolding) return;
  isHolding = false;

  const state = get(pttState);
  if (state !== 'transmitting') return;

  pttState.set('idle');
  stopCapture();
  send({ type: 'ptt_end' });
  playSquelchClose();
}

export function onPTTCancel(): void {
  onPTTUp();
}

// Handle channel_busy response from server — called from wsClient
export function onChannelBusy(): void {
  isHolding = false;
  stopCapture();
  playBusyTone();
  // pttState is set to 'busy' by wsClient, then reset after 2s
}

if (typeof document !== 'undefined') {
  // Release PTT on page hide (screen off, tab switch, etc.)
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) onPTTUp();
  });

  // Keyboard PTT shortcut
  document.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (e.key === get(pttKey)) {
      e.preventDefault();
      onPTTDown(e);
    }
  });

  document.addEventListener('keyup', (e) => {
    if (e.key === get(pttKey)) {
      onPTTUp();
    }
  });
}
