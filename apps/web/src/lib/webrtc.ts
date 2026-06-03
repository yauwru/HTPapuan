import { get } from 'svelte/store';
import { send, onOffer, onAnswer, onIceCandidate } from './wsClient.js';
import { sessionId, members } from './stores/channel.js';
import type { TurnCredentials } from '@starry-glade/protocol';

// Map of remoteSessionId -> RTCPeerConnection
const peerConnections = new Map<string, RTCPeerConnection>();
let localStream: MediaStream | null = null;
let turnCreds: TurnCredentials | null = null;

function iceServers(): RTCIceServer[] {
  const servers: RTCIceServer[] = [
    { urls: 'stun:stun.l.google.com:19302' },
  ];
  if (turnCreds) {
    servers.push({
      urls: turnCreds.urls,
      username: turnCreds.username,
      credential: turnCreds.credential,
    });
  }
  return servers;
}

function createPeer(remoteId: string, polite: boolean): RTCPeerConnection {
  const pc = new RTCPeerConnection({
    iceServers: iceServers(),
    iceTransportPolicy: 'all',
    bundlePolicy: 'max-bundle',
    rtcpMuxPolicy: 'require',
    iceCandidatePoolSize: 2,
  });

  pc.onicecandidate = ({ candidate }) => {
    if (candidate) {
      send({ type: 'ice_candidate', to: remoteId, candidate: candidate.toJSON() });
    }
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
      peerConnections.delete(remoteId);
    }
  };

  pc.ontrack = (event) => {
    const audio = new Audio();
    audio.srcObject = event.streams[0];
    audio.autoplay = true;
    audio.play().catch(() => {/* requires user gesture, handled by PTT press */});
  };

  if (localStream) {
    for (const track of localStream.getTracks()) {
      pc.addTrack(track, localStream);
    }
  }

  // Apply Opus parameters via SDP munging after offer is created
  peerConnections.set(remoteId, pc);
  return pc;
}

function mungeOpusSDP(sdp: string): string {
  // Set Opus parameters for low-bandwidth voice
  return sdp
    .replace(/a=fmtp:(\d+) (.*)opus(.*)/gi, (match, pt, prefix, suffix) => {
      const params = [
        'maxaveragebitrate=8000',
        'maxplaybackrate=8000',
        'usedtx=1',
        'useinbandfec=1',
        'cbr=0',
        'stereo=0',
        'sprop-stereo=0',
      ];
      return `a=fmtp:${pt} ${params.join(';')}`;
    })
    .replace(/a=mid:audio\r?\n/g, 'a=mid:audio\r\nb=AS:16\r\n');
}

export function initWebRTC(creds: TurnCredentials | null): void {
  turnCreds = creds;

  // Wire up signaling handlers
  (window as unknown as { __sgOnOffer: typeof onOffer }).__sgOnOffer = null;

  // Use module-level assignment via re-export trick
  setupSignaling();
}

function setupSignaling(): void {
  // These are set on the wsClient module — imported via side-effect
  import('./wsClient.js').then((wsc) => {
    wsc.onOffer = async (from, sdp) => {
      let pc = peerConnections.get(from);
      if (!pc) {
        pc = createPeer(from, true); // polite peer — yields to incoming offer
      }

      try {
        await pc.setRemoteDescription({ type: 'offer', sdp });
        const answer = await pc.createAnswer();
        answer.sdp = mungeOpusSDP(answer.sdp ?? '');
        await pc.setLocalDescription(answer);
        send({ type: 'answer', to: from, sdp: answer.sdp ?? '' });
      } catch (e) {
        console.error('[WebRTC] Failed to handle offer', e);
      }
    };

    wsc.onAnswer = async (from, sdp) => {
      const pc = peerConnections.get(from);
      if (!pc) return;
      try {
        await pc.setRemoteDescription({ type: 'answer', sdp });
      } catch (e) {
        console.error('[WebRTC] Failed to handle answer', e);
      }
    };

    wsc.onIceCandidate = async (from, candidate) => {
      const pc = peerConnections.get(from);
      if (!pc) return;
      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (e) {
        console.error('[WebRTC] Failed to add ICE candidate', e);
      }
    };
  });
}

export async function startTransmission(): Promise<void> {
  if (!localStream) {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
        sampleRate: 8000,
      },
      video: false,
    });
  }

  // Create peer connections to all current members
  const myId = get(sessionId);
  const currentMembers = get(members);

  for (const member of currentMembers) {
    if (member.sessionId === myId) continue;

    let pc = peerConnections.get(member.sessionId);
    if (!pc) {
      pc = createPeer(member.sessionId, false); // impolite — we initiate
    }

    // Add local stream tracks if not already added
    const senders = pc.getSenders();
    for (const track of localStream.getTracks()) {
      if (!senders.find((s) => s.track === track)) {
        pc.addTrack(track, localStream);
      }
    }

    try {
      const offer = await pc.createOffer();
      offer.sdp = mungeOpusSDP(offer.sdp ?? '');
      await pc.setLocalDescription(offer);
      send({ type: 'offer', to: member.sessionId, sdp: offer.sdp ?? '' });
    } catch (e) {
      console.error('[WebRTC] Failed to create offer', e);
    }
  }

  // Unmute all tracks
  for (const track of localStream.getAudioTracks()) {
    track.enabled = true;
  }
}

export function stopTransmission(): void {
  if (!localStream) return;

  // Mute (don't stop — stopping causes mic re-acquisition delay next PTT)
  for (const track of localStream.getAudioTracks()) {
    track.enabled = false;
  }
}

export function cleanup(): void {
  for (const pc of peerConnections.values()) {
    pc.close();
  }
  peerConnections.clear();

  if (localStream) {
    for (const track of localStream.getTracks()) track.stop();
    localStream = null;
  }
}
