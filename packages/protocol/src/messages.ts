export interface Member {
  callsign: string;
  sessionId: string;
  joinedAt: number;
}

export interface TurnCredentials {
  urls: string[];
  username: string;
  credential: string;
  ttl: number;
}

// Client → Server
export type ClientMessage =
  | { type: 'join'; frequency: string; callsign: string; password?: string }
  | { type: 'leave' }
  | { type: 'ptt_start'; mimeType?: string; sampleRate?: number }
  | { type: 'ptt_end' }
  | { type: 'offer'; to: string; sdp: string }
  | { type: 'answer'; to: string; sdp: string }
  | { type: 'ice_candidate'; to: string; candidate: RTCIceCandidateInit }
  | { type: 'text_broadcast'; text: string }
  | { type: 'roger' }
  | { type: 'audio_chunk'; data: ArrayBuffer };

// Server → Client
export type ServerMessage =
  | { type: 'joined'; sessionId: string; members: Member[]; turnCredentials: TurnCredentials | null }
  | { type: 'member_joined'; member: Member }
  | { type: 'member_left'; callsign: string; sessionId: string }
  | { type: 'speaker_start'; callsign: string; sessionId: string; mimeType?: string; sampleRate?: number }
  | { type: 'speaker_end'; callsign: string }
  | { type: 'channel_busy'; speakerCallsign: string }
  | { type: 'offer'; from: string; sdp: string }
  | { type: 'answer'; from: string; sdp: string }
  | { type: 'ice_candidate'; from: string; candidate: RTCIceCandidateInit }
  | { type: 'text_broadcast'; callsign: string; text: string; timestamp: number }
  | { type: 'roger'; callsign: string }
  | { type: 'error'; code: string; message: string }
  | { type: 'ping' };
