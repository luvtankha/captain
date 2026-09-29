import { randomBytes, timingSafeEqual } from 'node:crypto';

const LOOPBACK_ORIGINS = new Set(['http://127.0.0.1:4317', 'http://localhost:4317']);
const EXTENSION_ORIGIN = /^chrome-extension:\/\/[a-p]{32}$/;

export function allowedOrigin(origin, boundExtensionOrigin = '') {
  if (!origin) return true;
  return LOOPBACK_ORIGINS.has(origin) ||
    (origin === boundExtensionOrigin && EXTENSION_ORIGIN.test(boundExtensionOrigin));
}

export function responseOrigin(origin, boundExtensionOrigin = '') {
  return origin && allowedOrigin(origin, boundExtensionOrigin) ? origin : LOOPBACK_ORIGINS.values().next().value;
}

export function createRateLimiter({ limit = 60, windowMs = 60_000, now = Date.now } = {}) {
  const clients = new Map();
  return (key) => {
    const time = now(), existing = clients.get(key);
    if (!existing || time - existing.started >= windowMs) {
      clients.set(key, { started: time, count: 1 });
      return { allowed: true, remaining: limit - 1 };
    }
    existing.count++;
    return { allowed: existing.count <= limit, remaining: Math.max(0, limit - existing.count), retryAfterMs: Math.max(0, windowMs - (time - existing.started)) };
  };
}

export function isJsonRequest(headers = {}) {
  return /^application\/json(?:\s*;|$)/i.test(headers['content-type'] || '');
}

export function validCompanionToken(headers = {}, expected = '') {
  const supplied = headers['x-captain-auth'];
  if (typeof supplied !== 'string' || !/^[a-f0-9]{64}$/i.test(supplied) ||
      typeof expected !== 'string' || !/^[a-f0-9]{64}$/i.test(expected)) return false;
  const a = Buffer.from(supplied.toLowerCase(), 'ascii');
  const b = Buffer.from(expected.toLowerCase(), 'ascii');
  return a.length === b.length && timingSafeEqual(a, b);
}

// The durable launcher secret is only a bootstrap credential. Every launcher
// activation issues a fresh, origin-bound, expiring token to the trusted
// extension session. Never expose the bootstrap secret to the browser.
export const COMPANION_SESSION_TTL_MS = 60 * 60 * 1000;
export function issueCompanionSession(extensionOrigin, { now = Date.now, random = randomBytes } = {}) {
  if (typeof extensionOrigin !== 'string' || !EXTENSION_ORIGIN.test(extensionOrigin))
    throw new Error('Invalid CAPTAIN extension origin.');
  const timestamp = now();
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) throw new Error('Invalid session clock.');
  const token = random(32).toString('hex');
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid generated session token.');
  return { origin: extensionOrigin, token, expiresAt: timestamp + COMPANION_SESSION_TTL_MS };
}
export function validCompanionSession(headers = {}, session, now = Date.now) {
  return Boolean(session && Number.isSafeInteger(session.expiresAt) &&
    now() < session.expiresAt && headers.origin === session.origin &&
    allowedOrigin(headers.origin, session.origin) &&
    validCompanionToken(headers, session.token));
}
