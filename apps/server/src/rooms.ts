import type { Member, VisitLogEntry, UserRole, FrequencyEntry } from '@starry-glade/protocol';

export interface Session {
  id: string;
  callsign: string;
  role: UserRole;
  frequency: string | null;
  ws: unknown;
}

export interface Room {
  frequency: string;
  members: Map<string, Session>;
  pttHolder: string | null;
  pttCallsign: string | null;
  lastActivity: number;
  visitLog: VisitLogEntry[];
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
      visitLog: [],
    });
  }
  return rooms.get(frequency)!;
}

export function getRoom(frequency: string): Room | undefined {
  return rooms.get(frequency);
}

export function createSession(id: string, ws: unknown): Session {
  const session: Session = { id, callsign: '', role: 'pilot', frequency: null, ws };
  sessions.set(id, session);
  return session;
}

export function getSession(id: string): Session | undefined {
  return sessions.get(id);
}

export function joinRoom(session: Session, frequency: string, callsign: string, role: UserRole): Room {
  session.callsign = callsign;
  session.role = role;
  session.frequency = frequency;

  const room = getOrCreateRoom(frequency);
  room.members.set(session.id, session);
  room.lastActivity = Date.now();

  // Remove any stale entry for this session, then append fresh entry
  room.visitLog = room.visitLog.filter((e) => e.sessionId !== session.id);
  room.visitLog.push({ callsign, sessionId: session.id, joinedAt: Date.now(), leftAt: null, role });
  if (room.visitLog.length > 200) room.visitLog = room.visitLog.slice(-200);

  return room;
}

export function leaveRoom(session: Session): Room | null {
  if (!session.frequency) return null;

  const room = rooms.get(session.frequency);
  if (!room) return null;

  room.members.delete(session.id);
  room.lastActivity = Date.now();

  // Mark departure time in the log
  const entry = room.visitLog.find((e) => e.sessionId === session.id && e.leftAt === null);
  if (entry) entry.leftAt = Date.now();

  // Release PTT lock if this session held it
  if (room.pttHolder === session.id) {
    room.pttHolder = null;
    room.pttCallsign = null;
  }

  // Keep the room alive so the visit log persists — stale cleanup handles removal
  session.frequency = null;
  return room;
}

export function removeSession(id: string): void {
  sessions.delete(id);
}

export function acquirePTT(room: Room, session: Session): boolean {
  if (room.pttHolder !== null && room.pttHolder !== session.id) {
    return false;
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
    role: s.role,
  }));
}

export function getAllSessions(): IterableIterator<Session> {
  return sessions.values();
}

export function getDirectory(): FrequencyEntry[] {
  const result: FrequencyEntry[] = [];
  for (const room of rooms.values()) {
    if (room.members.size === 0) continue;
    let pilotCount = 0;
    let atcCount = 0;
    for (const s of room.members.values()) {
      if (s.role === 'atc') atcCount++; else pilotCount++;
    }
    result.push({ frequency: room.frequency, memberCount: room.members.size, pilotCount, atcCount });
  }
  return result.sort((a, b) => b.memberCount - a.memberCount);
}

// Cleanup stale rooms after 24 hours of no activity
setInterval(() => {
  const now = Date.now();
  for (const [freq, room] of rooms) {
    if (now - room.lastActivity > 24 * 60 * 60 * 1000) {
      rooms.delete(freq);
    }
  }
}, 60 * 60 * 1000);
