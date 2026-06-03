import { createHmac, randomBytes } from 'crypto';

const TURN_SECRET = process.env.TURN_SECRET ?? randomBytes(32).toString('hex');
const TURN_HOST = process.env.TURN_HOST ?? 'localhost';
const TURN_PORT = process.env.TURN_PORT ?? '3478';
const TURN_TLS_PORT = process.env.TURN_TLS_PORT ?? '5349';
const TTL = 24 * 3600; // 24 hours

export function generateTurnCredentials(): {
  urls: string[];
  username: string;
  credential: string;
  ttl: number;
} | null {
  if (!process.env.TURN_HOST) return null;

  const expires = Math.floor(Date.now() / 1000) + TTL;
  const username = `${expires}:user`;
  const credential = createHmac('sha1', TURN_SECRET).update(username).digest('base64');

  return {
    urls: [
      `stun:${TURN_HOST}:${TURN_PORT}`,
      `turn:${TURN_HOST}:${TURN_PORT}?transport=udp`,
      `turn:${TURN_HOST}:${TURN_PORT}?transport=tcp`,
      `turns:${TURN_HOST}:${TURN_TLS_PORT}?transport=tcp`,
    ],
    username,
    credential,
    ttl: TTL,
  };
}
