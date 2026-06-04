import { get } from 'svelte/store';
import {
  connectionState,
  sessionId,
  currentFrequency,
  currentCallsign,
  members,
  pttState,
  speakerCallsign,
  speakerSessionId,
  busyCallsign,
  networkRtt,
  addTextMessage,
} from './stores/channel.js';
import type { ClientMessage, ServerMessage } from '@starry-glade/protocol';

const SERVER_URL = import.meta.env.VITE_SERVER_URL ?? 'ws://localhost:3001';

let ws: WebSocket | null = null;
let reconnectDelay = 1000;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let pingTimer: ReturnType<typeof setInterval> | null = null;
let pingAt = 0;
let destroyed = false;

// Signaling callbacks — set by webrtc.ts
export let onOffer: ((from: string, sdp: string) => void) | null = null;
export let onAnswer: ((from: string, sdp: string) => void) | null = null;
export let onIceCandidate: ((from: string, candidate: RTCIceCandidateInit) => void) | null = null;

export function send(msg: ClientMessage): void {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

export function sendBinary(data: ArrayBuffer): void {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(data);
  }
}

export function connect(): void {
  destroyed = false;
  _connect();
}

function _connect(): void {
  if (ws) {
    ws.onclose = null;
    ws.close();
  }

  connectionState.set('connecting');
  ws = new WebSocket(SERVER_URL);
  ws.binaryType = 'arraybuffer';

  ws.onopen = () => {
    reconnectDelay = 1000;
    connectionState.set('connected');

    // Rejoin if we were in a channel
    const freq = get(currentFrequency);
    const callsign = get(currentCallsign);
    if (freq && callsign) {
      send({ type: 'join', frequency: freq, callsign });
    }

    // Keep-alive ping every 25s to prevent NAT timeout
    pingTimer = setInterval(() => {
      pingAt = Date.now();
      ws?.send('ping');
    }, 25_000);
  };

  ws.onmessage = (event) => {
    if (event.data instanceof ArrayBuffer) {
      import('./audio/relay.js').then(({ receiveChunk }) => receiveChunk(event.data as ArrayBuffer));
      return;
    }

    if (typeof event.data !== 'string') return;

    // Handle pong for RTT measurement
    if (event.data === 'pong') {
      if (pingAt > 0) networkRtt.set(Date.now() - pingAt);
      return;
    }

    let msg: ServerMessage;
    try {
      msg = JSON.parse(event.data) as ServerMessage;
    } catch {
      return;
    }

    switch (msg.type) {
      case 'joined':
        sessionId.set(msg.sessionId);
        members.set(msg.members);
        // Update TURN credentials now that we have them from the server
        import('./webrtc.js').then(({ initWebRTC }) => {
          initWebRTC(msg.turnCredentials);
        });
        break;

      case 'member_joined':
        members.update((m) => {
          if (m.find((x) => x.sessionId === msg.member.sessionId)) return m;
          return [...m, msg.member];
        });
        break;

      case 'member_left':
        members.update((m) => m.filter((x) => x.sessionId !== msg.sessionId));
        // Clear speaker if they disconnected
        speakerSessionId.update((sid) => {
          if (sid === msg.sessionId) {
            speakerCallsign.set(null);
            speakerSessionId.set(null);
          }
          return sid === msg.sessionId ? null : sid;
        });
        break;

      case 'speaker_start':
        speakerCallsign.set(msg.callsign);
        speakerSessionId.set(msg.sessionId);
        pttState.set('idle'); // we're in receive mode
        import('./audio/relay.js').then(({ beginReceiving }) => beginReceiving(msg.mimeType ?? ''));
        break;

      case 'speaker_end':
        speakerCallsign.set(null);
        speakerSessionId.set(null);
        import('./audio/relay.js').then(({ playReceived }) => playReceived());
        break;

      case 'channel_busy':
        busyCallsign.set(msg.speakerCallsign);
        pttState.set('busy');
        setTimeout(() => {
          pttState.set('idle');
          busyCallsign.set(null);
        }, 2000);
        break;

      case 'text_broadcast':
        addTextMessage({ callsign: msg.callsign, text: msg.text, timestamp: msg.timestamp });
        break;

      case 'offer':
        onOffer?.(msg.from, msg.sdp);
        break;

      case 'answer':
        onAnswer?.(msg.from, msg.sdp);
        break;

      case 'ice_candidate':
        onIceCandidate?.(msg.from, msg.candidate);
        break;

      case 'ping':
        ws?.send('pong');
        break;
    }
  };

  ws.onerror = () => {
    // onclose will follow, handle reconnect there
  };

  ws.onclose = () => {
    clearInterval(pingTimer!);
    pingTimer = null;

    if (destroyed) return;

    connectionState.set('reconnecting');
    reconnectTimer = setTimeout(() => {
      reconnectDelay = Math.min(reconnectDelay * 2, 16_000);
      _connect();
    }, reconnectDelay);
  };
}

export function disconnect(): void {
  destroyed = true;
  clearTimeout(reconnectTimer!);
  clearInterval(pingTimer!);
  ws?.close();
  ws = null;
  connectionState.set('idle');
}

export function joinChannel(frequency: string, callsign: string): void {
  currentFrequency.set(frequency);
  currentCallsign.set(callsign);
  send({ type: 'join', frequency, callsign });
}

export function leaveChannel(): void {
  send({ type: 'leave' });
  currentFrequency.set(null);
  members.set([]);
  speakerCallsign.set(null);
  pttState.set('idle');
}
