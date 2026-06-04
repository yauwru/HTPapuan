import { get } from 'svelte/store';
import { pttState, isInChannel } from './stores/channel.js';
import { send, sendBinary } from './wsClient.js';
import { resumeAudio, playSquelchClose, playBusyTone } from './audio/squelch.js';
import { startCapture, stopCapture } from './audio/relay.js';

let isHolding = false;

export async function onPTTDown(event: PointerEvent): Promise<void> {
  event.preventDefault();

  if (!get(isInChannel)) return;
  if (isHolding) return;

  const state = get(pttState);
  if (state === 'transmitting') return;

  // Resume AudioContext — this is the required user gesture
  await resumeAudio();

  isHolding = true;
  pttState.set('transmitting');

  send({ type: 'ptt_start' });

  try {
    await startCapture((chunk) => sendBinary(chunk));
  } catch (e) {
    console.error('[PTT] Failed to start capture', e);
    isHolding = false;
    pttState.set('idle');
    send({ type: 'ptt_end' });
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

// Ensure PTT is released on page hide (screen off, tab switch, etc.)
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) onPTTUp();
  });
}
