import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../extension/service-worker.js', import.meta.url), 'utf8');

function fixture(codes) {
  const observations = [], requests = [], states = [], invalidated = [];
  const tab = { id: 7, windowId: 3, incognito: false, url: 'http://127.0.0.1:4317/visual-fixture.html' };
  const sandbox = {
    URL, AbortController, performance, setTimeout, clearTimeout,
    chrome: {
      runtime: { id: 'synthetic-extension', onMessage: { addListener() {} } },
      tabs: { get: async () => tab },
      storage: { session: { set: async () => {} } },
    },
    fetch: async (url, options) => {
      if (url.endsWith('/api/metrics')) return { ok: true };
      const attempt = requests.length;
      requests.push(JSON.parse(options.body));
      const code = codes[attempt];
      return code ? { ok: false, status: 500, json: async () => ({ code, error: 'Request could not be processed' }) }
        : { ok: true, status: 200, json: async () => ({ planner: 'fast-command', action: { type: 'finish', message: 'Done' } }) };
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  Object.assign(sandbox, {
    settings: async () => ({ serverUrl: 'http://127.0.0.1:4317', maxSteps: 4, includeScreenshot: true }),
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
      observations.push(observations.length + 1);
      return { url: tab.url, title: 'Synthetic public fixture', elements: [], piiCounts: {},
        screenshot: `proof-bound-synthetic-image-${observations.length}`,
        pageMetadata: { documentToken: 'synthetic', observationId: `obs-${observations.length}`, domRevision: 1, geometryRevision: 1 },
        vision: { status: 'sanitized' } };
    },
    mintLocalActionLease: (_tab, _context, step) => ({ id: step }),
    plannerContext: context => context,
    pageChange: () => 'unchanged',
    validatePlannedActionOnDevice: async () => {},
    enforceActionPrivacy: () => {},
    metricProjection: () => ({}),
    timelineEvent: () => {},
    clearPrivacySession: () => {},
  });
  sandbox.CAPTAIN_ACTION_BINDING = { invalidateTaskBinding: lease => invalidated.push(lease.id) };
  return { sandbox, observations, requests, states, invalidated };
}

test('one authenticated model timeout discards the old lease and sends a newly observed payload', async () => {
  const f = fixture(['MODEL_TIMEOUT', null]);
  await f.sandbox.run('Select a synthetic button', 7, 3);
  assert.equal(f.observations.length, 2);
  assert.equal(f.requests.length, 2);
  assert.notEqual(f.requests[0].context.screenshot, f.requests[1].context.screenshot);
  // First lease is discarded on timeout; the second is ordinarily invalidated
  // after the final action, not reused for a third model request.
  assert.deepEqual(f.invalidated, [1, 2]);
  assert.equal(f.states.at(-1).completionStatus, 'COMPLETED');
  assert.deepEqual(Array.from(f.states.at(-1).history, h => h.action?.type), ['finish']);
});

test('a second model timeout fails closed without a third request or action', async () => {
  const f = fixture(['MODEL_TIMEOUT', 'MODEL_TIMEOUT']);
  await f.sandbox.run('Select a synthetic button', 7, 3);
  assert.equal(f.observations.length, 2);
  assert.equal(f.requests.length, 2);
  assert.deepEqual(f.invalidated, [1]);
  assert.equal(f.states.at(-1).completionStatus, 'FAILED');
  assert.deepEqual(Array.from(f.states.at(-1).history), []);
});

test('other provider errors never trigger a privacy recapture/retry', async () => {
  for (const code of ['MODEL_EMPTY', 'MODEL_JSON_INVALID', 'MODEL_ACTION_INVALID', 'MODEL_UNAVAILABLE', 'PLANNER_FAILED']) {
    const f = fixture([code]);
    await f.sandbox.run('Select a synthetic button', 7, 3);
    assert.equal(f.observations.length, 1, code);
    assert.equal(f.requests.length, 1, code);
    assert.equal(f.states.at(-1).completionStatus, 'FAILED', code);
    assert.deepEqual(f.invalidated, [], code);
  }
});
