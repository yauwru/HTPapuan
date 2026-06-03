import type { Member } from '@starry-glade/protocol';

export interface Session {
  id: string;
  callsign: string;
  frequency: string | null;
  ws: unknown; // uWebSockets WebSocket handle
}

export interface Room {
  frequency: string;
  members: Map<string, Session>;
  pttHolder: string | null; // sessionId holding PTT lock
  pttCallsign: string | null;
  lastActivity: number;
}

const rooms = new Map<string, Room>();
const sessions = new Map<string, Session>();

export function getOrCreateRoom(frequency: string): Room {
  if (!rooms.has(frequency)) {
    rooms.set(frequency, {
      frequency,
      members: new Map(),
      pttHolder: null,
      pttCallsign: null,
      lastActivity: Date.now(),
    });
  }
  return rooms.get(frequency)!;
}

export function getRoom(frequency: string): Room | undefined {
  return rooms.get(frequency);
}

export function createSession(id: string, ws: unknown): Session {
  const session: Session = { id, callsign: '', frequency: null, ws };
  sessions.set(id, session);
  return session;
}

export function getSession(id: string): Session | undefined {
  return sessions.get(id);
}

export function joinRoom(session: Session, frequency: string, callsign: string): Room {
  session.callsign = callsign;
  session.frequency = frequency;

  const room = getOrCreateRoom(frequency);
  room.members.set(session.id, session);
  room.lastActivity = Date.now();
  return room;
}

export function leaveRoom(session: Session): Room | null {
  if (!session.frequency) return null;

  const room = rooms.get(session.frequency);
  if (!room) return null;

  room.members.delete(session.id);

  // Release PTT lock if this session held it
  if (room.pttHolder === session.id) {
    room.pttHolder = null;
    room.pttCallsign = null;
  }

  // Clean up empty rooms
  if (room.members.size === 0) {
    rooms.delete(session.frequency);
  }

  session.frequency = null;
  return room;
}

export function removeSession(id: string): void {
  sessions.delete(id);
}

export function acquirePTT(room: Room, session: Session): boolean {
  if (room.pttHolder !== null && room.pttHolder !== session.id) {
    return false; // Channel busy
  }
  room.pttHolder = session.id;
  room.pttCallsign = session.callsign;
  room.lastActivity = Date.now();
  return true;
}

export function releasePTT(room: Room, sessionId: string): boolean {
  if (room.pttHolder !== sessionId) return false;
  room.pttHolder = null;
  room.pttCallsign = null;
  return true;
}

export function getRoomMembers(room: Room): Member[] {
  return Array.from(room.members.values()).map((s) => ({
    callsign: s.callsign,
    sessionId: s.id,
    joinedAt: Date.now(),
  }));
}

// Cleanup stale rooms every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [freq, room] of rooms) {
    if (room.members.size === 0 && now - room.lastActivity > 10 * 60 * 1000) {
      rooms.delete(freq);
    }
  }
}, 10 * 60 * 1000);
