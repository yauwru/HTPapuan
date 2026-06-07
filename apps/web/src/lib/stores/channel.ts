import { writable, derived } from 'svelte/store';
import type { Member, VisitLogEntry, UserRole, FrequencyEntry } from '@starry-glade/protocol';
export type { UserRole, FrequencyEntry };

export type ConnectionState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'error';
export type PTTState = 'idle' | 'transmitting' | 'busy';

export const connectionState = writable<ConnectionState>('idle');
export const sessionId = writable<string | null>(null);
export const currentFrequency = writable<string | null>(null);
export const currentCallsign = writable<string>('');
export const currentRole = writable<UserRole>('pilot');
export const members = writable<Member[]>([]);
export const pttState = writable<PTTState>('idle');
export const speakerCallsign = writable<string | null>(null);
export const speakerSessionId = writable<string | null>(null);
export const busyCallsign = writable<string | null>(null);

export const isConnected = derived(connectionState, ($s) => $s === 'connected');
export const isInChannel = derived(currentFrequency, ($f) => $f !== null);

export const visitLog = writable<VisitLogEntry[]>([]);
export const frequencyDirectory = writable<FrequencyEntry[]>([]);

// Text messages (Phase 2 - stored locally)
export interface TextMessage {
  callsign: string;
  text: string;
  timestamp: number;
}
export const textMessages = writable<TextMessage[]>([]);

export function addTextMessage(msg: TextMessage): void {
  textMessages.update((msgs) => [...msgs.slice(-49), msg]);
}

// Network quality (RTT in ms, -1 = unknown)
export const networkRtt = writable<number>(-1);
export const signalStrength = derived(networkRtt, ($rtt) => {
  if ($rtt < 0) return 0;
  if ($rtt < 100) return 5;
  if ($rtt < 300) return 4;
  if ($rtt < 600) return 3;
  if ($rtt < 1200) return 2;
  return 1;
});
