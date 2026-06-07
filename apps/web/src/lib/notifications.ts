import type { UserRole } from '@starry-glade/protocol';

export async function requestNotificationPermission(): Promise<void> {
  if (typeof Notification === 'undefined') return;
  if (Notification.permission === 'default') {
    await Notification.requestPermission();
  }
}

export function notifyMemberJoined(callsign: string, role: UserRole, frequency: string): void {
  if (typeof Notification === 'undefined') return;
  if (Notification.permission !== 'granted') return;
  if (typeof document !== 'undefined' && document.hasFocus()) return;

  new Notification(`${callsign} masuk ke ${frequency}`, {
    body: role === 'atc' ? '📡 ATC online' : '✈️ Pilot bergabung',
    icon: '/favicon.ico',
    tag: `join-${callsign}`,
    silent: true,
  });
}
