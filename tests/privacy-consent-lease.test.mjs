import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const extension = new URL('../extension/', import.meta.url);
const [worker, binding] = await Promise.all([
  readFile(new URL('service-worker.js', extension), 'utf8'),
  readFile(new URL('action-binding-runtime.js', extension), 'utf8'),
]);

function fixture({ changeProtection = false } = {}) {
  let now = 1_000, listener, observations = 0;
  const requests = [], states = [];
  const tab = { id: 7, windowId: 3, incognito: false, url: 'https://fixture.example/protected' };
  const sandbox = {
    URL, AbortController, setTimeout, clearTimeout,
    performance: { now: () => now },
    chrome: {
      runtime: { id: 'synthetic-extension', onMessage: { addListener(callback) { listener = callback; } } },
      tabs: { get: async () => tab },
      storage: { session: { set: async () => {} } },
    },
    fetch: async (url, options = {}) => {
      if (String(url).endsWith('/api/metrics')) return { ok: true, status: 200, json: async () => ({}) };
      requests.push(JSON.parse(options.body));
      return { ok: true, status: 200, json: async () => ({
        planner: 'fast-command', action: { type: 'finish', message: 'Done' },
      }) };
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(binding, sandbox);
  vm.runInContext(worker, sandbox);
  Object.assign(sandbox, {
    settings: async () => ({ serverUrl: 'http://127.0.0.1:4317', maxSteps: 1, includeScreenshot: true }),
    normalizeLoopbackServerUrl: value => value,
    companionAuthToken: async () => 'a'.repeat(64),
    sanitizeCommand: value => value,
    sanitizePayload: value => value,
    assertNoPrivatePlannerText: () => {},
    state: async value => { states.push(value); },
    resolveTarget: async () => tab,
    bindTarget: async () => {},
    focusTarget: async () => {},
    observe: async () => {
      observations++;
      return {
        url: tab.url, title: 'Protected synthetic fixture', elements: [],
        piiCounts: { EMAIL: changeProtection && observations > 1 ? 2 : 1 }, screenshot: `fresh-proof-${observations}`,
        pageMetadata: {
          documentToken: 'synthetic-protected-document', observationId: `opaque-observation-${observations}`,
          domRevision: 1, geometryRevision: 1, domFingerprint: 'abcdef01', visibleTextHash: '23456789',
          elementCount: 0, meaningfulContent: true, capturedAt: observations,
        },
        vision: { status: 'sanitized' },
      };
    },
    plannerContext: context => context,
    pageChange: () => 'unchanged',
    enforceActionPrivacy: () => {},
    metricProjection: () => ({}),
    timelineEvent: () => {},
    clearPrivacySession: () => {},
  });
  return {
    sandbox, requests, states,
    get observations() { return observations; },
    advance(ms) { now += ms; },
    waitingForApproval: () => vm.runInContext('privacyApproval !== null', sandbox),
    async respond(type) {
      return await new Promise((resolve, reject) => {
        if (!listener) return reject(new Error('privacy message listener was not registered'));
        const keepAlive = listener({ type }, {}, resolve);
        if (keepAlive !== true) reject(new Error('privacy message listener did not keep its response channel open'));
      });
    },
  };
}

async function waitFor(predicate, label) {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  assert.fail(`Timed out waiting for ${label}`);
}

test('new protected fields after approval require renewed consent before planner access', async () => {
  const f = fixture({ changeProtection: true });
  const task = f.sandbox.run('Finish the synthetic protected task', 7, 3);
  await waitFor(f.waitingForApproval, 'first consent');
  await f.respond('PRIVACY_CONTINUE');
  await waitFor(() => f.observations === 2 && f.waitingForApproval(), 'changed protection consent');
  assert.equal(f.requests.length, 0);
  await f.respond('PRIVACY_CONTINUE');
  await task;
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].context.screenshot, 'fresh-proof-3');
});

test('privacy continue discards an expired pre-consent lease and replans from a fresh proof', async () => {
  const f = fixture();
  const task = f.sandbox.run('Finish the synthetic protected task', 7, 3);
  await waitFor(() => f.states.some(state => state.status === 'waiting_privacy_consent'), 'privacy-consent state');
  await waitFor(f.waitingForApproval, 'privacy approval handler');

  // The user reviewed the marks for longer than the 120-second action lease.
  f.advance(120_001);
  const response = await f.respond('PRIVACY_CONTINUE');
  assert.equal(response.ok, true);
  assert.equal(response.choice, 'continue');
  await task;

  assert.equal(f.observations, 2, 'approval triggers a new local observation');
  assert.equal(f.requests.length, 1, 'the pre-consent context is never sent to the planner');
  assert.equal(f.requests[0].context.screenshot, 'fresh-proof-2', 'only the post-consent proof reaches the planner');
  assert.ok(f.states.some(state => state.phase === 'REOBSERVING'));
  assert.equal(f.states.at(-1).completionStatus, 'COMPLETED');
});
