import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const worker = await readFile(new URL('../extension/service-worker.js', import.meta.url), 'utf8');
const launcher = await readFile(new URL('../tools/start-demo.mjs', import.meta.url), 'utf8');
const server = await readFile(new URL('../server/index.mjs', import.meta.url), 'utf8');

test('companion credential is provisioned in trusted session storage, not content-script-readable local storage', () => {
  assert.match(worker, /chrome\.storage\.session\.get\(\{ captainCompanionToken: '' \}\)/);
  assert.doesNotMatch(worker, /chrome\.storage\.local\.get\(\{ captainCompanionToken/);
  assert.match(launcher, /chrome\.storage\.session\.set\(\{captainCompanionToken:/);
  assert.match(launcher, /chrome\.storage\.session\.setAccessLevel\(\{accessLevel:'TRUSTED_CONTEXTS'\}\)/);
  assert.match(launcher, /chrome\.storage\.local\.remove\('captainCompanionToken'\)/);
});

test('companion enforces loopback-only binding before accepting authenticated observations', () => {
  assert.match(server, /if \(host !== "127\.0\.0\.1"\)/);
  assert.match(server, /validCompanionToken\(req\.headers, companionToken\)/);
  assert.match(server, /validCompanionSession\(req\.headers, browserSession\)/);
  assert.match(launcher, /\/api\/companion\/session/);
});

test('a stale local token is not accepted when trusted session token is missing', async () => {
  let listener, state, observations = 0;
  const chrome = {
    runtime: { onMessage: { addListener(fn) { listener = fn; } } },
    storage: {
      session: { get: async () => ({}) },
      local: { get: async () => ({ captainCompanionToken: 'a'.repeat(64) }),
        set: async value => { state = value.captainState; } },
      sync: { get: async () => ({}) }
    },
    tabs: { get: async () => { observations++; return { id: 1, incognito: true }; } }
  };
  vm.runInNewContext(worker, { chrome, URL, performance, setTimeout, AbortController });
  listener({ type: 'START_TASK', task: 'open YouTube' }, { tab: { id: 1 } }, () => {});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.status, 'error');
  assert.match(state.message, /companion authentication is unavailable/);
  assert.equal(observations, 0);
});
