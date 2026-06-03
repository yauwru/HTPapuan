import { get } from 'svelte/store';
import { pttState, isInChannel } from './stores/channel.js';
import { send } from './wsClient.js';
import { resumeAudio, playSquelchClose, playBusyTone } from './audio/squelch.js';
import { startTransmission, stopTransmission } from './webrtc.js';

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

  // Start WebRTC audio immediately (server will reject if channel busy)
  try {
    await startTransmission();
  } catch (e) {
    console.error('[PTT] Failed to start transmission', e);
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
  stopTransmission();
  send({ type: 'ptt_end' });
  playSquelchClose();
}

export function onPTTCancel(): void {
  onPTTUp();
}

// Handle channel_busy response from server — called from wsClient
export function onChannelBusy(): void {
  isHolding = false;
  stopTransmission();
  playBusyTone();
  // pttState is set to 'busy' by wsClient, then reset after 2s
}

// Ensure PTT is released on page hide (screen off, tab switch, etc.)
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) onPTTUp();
  });
}
