import test from 'node:test';
import assert from 'node:assert/strict';
import { allowedOrigin, createRateLimiter, isJsonRequest, issueCompanionSession,
  validCompanionSession, COMPANION_SESSION_TTL_MS } from '../server/security.mjs';

test('server permits loopback UI and only the exact bound Chrome extension origin', () => {
  const bound = `chrome-extension://${'a'.repeat(32)}`;
  assert.equal(allowedOrigin(), true);
  assert.equal(allowedOrigin('http://127.0.0.1:4317'), true);
  assert.equal(allowedOrigin('http://localhost:4317'), true);
  assert.equal(allowedOrigin(bound), false);
  assert.equal(allowedOrigin(bound, bound), true);
  assert.equal(allowedOrigin(`chrome-extension://${'b'.repeat(32)}`, bound), false);
  for (const origin of ['https://evil.example', 'http://127.0.0.1:9999', 'chrome-extension://short', `chrome-extension://${'z'.repeat(32)}`]) assert.equal(allowedOrigin(origin), false);
});

test('short-lived bound token is distinct from bootstrap, expires and rejects missing/spoofed origin', () => {
  const bound = `chrome-extension://${'a'.repeat(32)}`;
  const start = 1_000_000;
  const first = issueCompanionSession(bound, { now: () => start,
    random: () => Buffer.alloc(32, 7) });
  const headers = { origin: bound, 'x-captain-auth': first.token };
  assert.equal(first.expiresAt - start, COMPANION_SESSION_TTL_MS);
  assert.equal(validCompanionSession(headers, first, () => start + 1), true);
  assert.equal(validCompanionSession({ 'x-captain-auth': first.token }, first, () => start + 1), false);
  assert.equal(validCompanionSession({ ...headers, origin: `chrome-extension://${'b'.repeat(32)}` }, first, () => start + 1), false);
  assert.equal(validCompanionSession({ ...headers, 'x-captain-auth': 'b'.repeat(64) }, first, () => start + 1), false);
  assert.equal(validCompanionSession(headers, first, () => first.expiresAt), false);
  assert.throws(() => issueCompanionSession('https://evil.example'), /Invalid CAPTAIN extension origin/);
});

test('rate limiter enforces its window and resets without retaining request data', () => {
  let clock = 1000;
  const check = createRateLimiter({ limit: 2, windowMs: 100, now: () => clock });
  assert.equal(check('client').allowed, true);
  assert.equal(check('client').allowed, true);
  assert.equal(check('client').allowed, false);
  assert.equal(check('other').allowed, true);
  clock += 101;
  assert.equal(check('client').allowed, true);
});

test('state-changing endpoints require JSON content type', () => {
  assert.equal(isJsonRequest({ 'content-type': 'application/json' }), true);
  assert.equal(isJsonRequest({ 'content-type': 'application/json; charset=utf-8' }), true);
  assert.equal(isJsonRequest({ 'content-type': 'text/plain' }), false);
});
