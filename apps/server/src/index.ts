import { App, SHARED_COMPRESSOR, type WebSocket } from 'uWebSockets.js';
import { randomUUID } from 'crypto';
import {
  createSession,
  getSession,
  getRoom,
  joinRoom,
  leaveRoom,
  removeSession,
  acquirePTT,
  releasePTT,
  getRoomMembers,
  type Session,
} from './rooms.js';
import { generateTurnCredentials } from './turn.js';
import type { ClientMessage, ServerMessage } from '@starry-glade/protocol';

const PORT = parseInt(process.env.PORT ?? '3001');

interface UserData {
  sessionId: string;
}

type WS = WebSocket<UserData>;

function send(ws: WS, message: ServerMessage): void {
  ws.send(JSON.stringify(message), false, true);
}

function broadcast(members: Iterable<Session>, message: ServerMessage, excludeId?: string): void {
  const payload = JSON.stringify(message);
  for (const member of members) {
    if (member.id !== excludeId) {
      (member.ws as WS).send(payload, false, true);
    }
  }
}

const app = App();

app.ws<UserData>('/*', {
  compression: SHARED_COMPRESSOR,
  maxPayloadLength: 64 * 1024,
  idleTimeout: 60,

  open(ws) {
    const sessionId = randomUUID();
    ws.getUserData().sessionId = sessionId;
    createSession(sessionId, ws);
    console.log(`[+] ${sessionId} connected`);
  },

  message(ws, rawMessage, isBinary) {
    const { sessionId } = ws.getUserData();
    const session = getSession(sessionId);
    if (!session) return;

    if (isBinary) {
      if (!session.frequency) return;
      const room = getRoom(session.frequency);
      if (!room || room.pttHolder !== sessionId) return;
      // Copy the buffer — uWebSockets reuses the underlying memory after callback returns
      const copy = Buffer.from(rawMessage);
      let relayed = 0;
      for (const member of room.members.values()) {
        if (member.id !== sessionId) {
          (member.ws as WS).send(copy, true);
          relayed++;
        }
      }
      if (relayed > 0) console.log(`[AUD] relayed ${copy.byteLength}B to ${relayed} listeners`);
      return;
    }

    let msg: ClientMessage;
    try {
      msg = JSON.parse(Buffer.from(rawMessage).toString()) as ClientMessage;
    } catch {
      return;
    }

    switch (msg.type) {
      case 'join': {
        const freq = msg.frequency.replace(/[^A-Z0-9._\-]/gi, '').toUpperCase().slice(0, 12);
        const sign = msg.callsign.replace(/[^A-Z0-9\-_ ]/gi, '').slice(0, 12).trim();
        if (!freq || !sign) return;

        const room = joinRoom(session, freq, sign);
        const turnCredentials = generateTurnCredentials();

        send(ws, {
          type: 'joined',
          sessionId,
          members: getRoomMembers(room),
          turnCredentials,
        });

        broadcast(room.members.values(), {
          type: 'member_joined',
          member: { callsign: sign, sessionId, joinedAt: Date.now() },
        }, sessionId);

        console.log(`[>] ${sign} joined ${freq} (${room.members.size} members)`);
        break;
      }

      case 'leave': {
        const room = session.frequency ? getRoom(session.frequency) : null;
        leaveRoom(session);
        if (room) {
          broadcast(room.members.values(), {
            type: 'member_left',
            callsign: session.callsign,
            sessionId,
          });
        }
        break;
      }

      case 'ptt_start': {
        if (!session.frequency) return;
        const room = getRoom(session.frequency);
        if (!room) return;

        const acquired = acquirePTT(room, session);
        if (!acquired) {
          send(ws, { type: 'channel_busy', speakerCallsign: room.pttCallsign ?? 'Unknown' });
          return;
        }

        broadcast(room.members.values(), {
          type: 'speaker_start',
          callsign: session.callsign,
          sessionId,
          mimeType: msg.mimeType,
        }, sessionId);

        console.log(`[PTT] ${session.callsign} TX on ${session.frequency}`);
        break;
      }

      case 'ptt_end': {
        if (!session.frequency) return;
        const room = getRoom(session.frequency);
        if (!room) return;

        const released = releasePTT(room, sessionId);
        if (released) {
          broadcast(room.members.values(), {
            type: 'speaker_end',
            callsign: session.callsign,
          });
          console.log(`[PTT] ${session.callsign} ended TX`);
        }
        break;
      }

      case 'offer':
      case 'answer':
      case 'ice_candidate': {
        if (!session.frequency) return;
        const room = getRoom(session.frequency);
        if (!room) return;

        const target = room.members.get(msg.to);
        if (!target) return;
        const targetWs = target.ws as WS;

        if (msg.type === 'offer') {
          targetWs.send(JSON.stringify({ type: 'offer', from: sessionId, sdp: msg.sdp } satisfies ServerMessage), false, true);
        } else if (msg.type === 'answer') {
          targetWs.send(JSON.stringify({ type: 'answer', from: sessionId, sdp: msg.sdp } satisfies ServerMessage), false, true);
        } else {
          targetWs.send(JSON.stringify({ type: 'ice_candidate', from: sessionId, candidate: msg.candidate } satisfies ServerMessage), false, true);
        }
        break;
      }

      case 'text_broadcast': {
        if (!session.frequency || !msg.text) return;
        const room = getRoom(session.frequency);
        if (!room) return;

        broadcast(room.members.values(), {
          type: 'text_broadcast',
          callsign: session.callsign,
          text: msg.text.slice(0, 80),
          timestamp: Date.now(),
        });
        break;
      }

      case 'roger': {
        if (!session.frequency) return;
        const room = getRoom(session.frequency);
        if (!room) return;

        broadcast(room.members.values(), {
          type: 'roger',
          callsign: session.callsign,
        }, sessionId);
        break;
      }
    }
  },

  close(ws) {
    const { sessionId } = ws.getUserData();
    const session = getSession(sessionId);
    if (!session) return;

    const freq = session.frequency;
    const callsign = session.callsign;
    const room = freq ? getRoom(freq) : null;

    leaveRoom(session);
    removeSession(sessionId);

    if (room) {
      broadcast(room.members.values(), {
        type: 'member_left',
        callsign,
        sessionId,
      });
    }

    console.log(`[-] ${sessionId} (${callsign || 'anon'}) disconnected`);
  },
});

app.get('/health', (res) => {
  res.writeStatus('200 OK').end('ok');
});

app.listen(PORT, (token) => {
  if (token) {
    console.log(`Starry Glade Radio server listening on port ${PORT}`);
  } else {
    console.error(`Failed to listen on port ${PORT}`);
    process.exit(1);
  }
});
