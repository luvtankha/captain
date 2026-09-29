import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import {
  ACTION_BINDING_TTL_MS, invalidateTaskBinding, validateActionOnDevice
} from '../extension/action-binding.mjs';

function fixture(action = { type: 'click', target: { ref: 'c1' } }) {
  const observation = {
    tabId: 7, windowId: 3, frameId: 0, origin: 'https://example.test',
    url: 'https://example.test/results', documentGeneration: 'document-1',
    observationId: 'observation-1', createdMonotonicMs: 1000, navigationEpoch: 1,
    elements: [
      { ref: 'c1', tag: 'a', name: 'Open public result', href: 'https://example.test/article', sensitive: false },
      { ref: 'c2', tag: 'input', name: 'Password', sensitive: true, sensitiveType: 'password' },
      { ref: 'c3', tag: 'button', name: 'Pay now', sensitive: false },
      { ref: 'c4', tag: 'input', type: 'search', name: 'Search products', sensitive: false },
      { ref: 'c5', tag: 'button', name: '', sensitive: false },
      { ref: 'c6', tag: 'a', name: 'Open a public page', href: 'https://example.test/delete-account', sensitive: false },
      { ref: 'c7', tag: 'input', type: 'text', name: 'Public note', sensitive: false },
      { ref: 'c8', tag: 'button', name: 'Continue', disabled: true, sensitive: false }
    ]
  };
  const binding = {
    tabId: observation.tabId, windowId: observation.windowId, frameId: observation.frameId,
    origin: observation.origin, url: observation.url, documentGeneration: observation.documentGeneration,
    observationId: observation.observationId, createdMonotonicMs: observation.createdMonotonicMs,
    navigationEpoch: observation.navigationEpoch, ttlMs: 2000, nowMonotonicMs: 1100
  };
  return { observation, binding, plan: { action } };
}

function authorizeLocally({ observation, binding, plan }, at = 1050) {
  // Simulates approval captured by a trusted extension click handler. A model
  // may place an object called confirmation in its own JSON; it cannot grant this.
  binding.confirmation = {
    approved: true, confirmedByLocalUser: true, action: plan.action,
    actionSnapshot: JSON.stringify(plan.action),
    observationId: observation.observationId,
    documentGeneration: observation.documentGeneration,
    confirmedAtMonotonicMs: at
  };
}

test('exports are browser-importable and familiar read-only actions retain their shapes', () => {
  assert.equal(ACTION_BINDING_TTL_MS, 120000);
  for (const action of [
    { type: 'click', target: { ref: 'c1' } },
    { type: 'hover', target: { ref: 'c1' } },
    { type: 'type', target: { ref: 'c4' }, value: 'synthetic query' },
    { type: 'select', target: { ref: 'c4' }, value: 'synthetic option' },
    { type: 'scroll', direction: 'down', amount: 300 },
    { type: 'wait', ms: 300 },
    { type: 'navigate', url: 'https://example.test/public' },
    { type: 'back' },
    { type: 'media', operation: 'play' },
    { type: 'finish', message: 'Task finished' },
    { type: 'submit', target: { ref: 'c4' } },
    { type: 'press', target: { ref: 'c4' }, key: 'Enter' }
  ]) {
    const f = fixture(action);
    const result = validateActionOnDevice(f.plan, f.observation, f.binding);
    assert.equal(result.action, action);
    assert.equal(result.observationId, 'observation-1');
    assert.equal(result.target?.ref ?? null, action.target?.ref ?? null);
  }
});

test('public search form submit, Enter, and type-submit remain available without payment confirmation', () => {
  for (const action of [
    { type: 'submit', target: { ref: 'c4' } },
    { type: 'press', target: { ref: 'c4' }, key: 'Enter' },
    { type: 'type', target: { ref: 'c4' }, value: 'synthetic query', submit: true }
  ]) {
    const f = fixture(action);
    f.observation.elements[3].name = 'Submit search';
    assert.equal(validateActionOnDevice(f.plan, f.observation, f.binding).action, action);
  }
});

test('a search label cannot bypass approval when the observed form advertises payment or deletion', () => {
  for (const action of [
    { type: 'submit', target: { ref: 'c4' } },
    { type: 'press', target: { ref: 'c4' }, key: 'Enter' },
    { type: 'type', target: { ref: 'c4' }, value: 'synthetic query', submit: true }
  ]) {
    const f = fixture(action);
    f.observation.elements[3].name = 'Search and delete account';
    assert.throws(() => validateActionOnDevice(f.plan, f.observation, f.binding), /confirmation/);
  }
});

test('consequential navigation includes hyphenated, camelCase, encoded and action-query routes', () => {
  for (const url of [
    'https://example.test/delete-account',
    'https://example.test/account/deleteAccount',
    'https://example.test/%64elete-account',
    'https://example.test/%2564elete-account',
    'https://example.test/public?action=delete',
    'https://example.test/public?operation=transfer',
    'https://example.test/#/cancel-subscription'
  ]) {
    const f = fixture({ type: 'navigate', url });
    assert.throws(() => validateActionOnDevice(f.plan, f.observation, f.binding), /confirmation/);
    authorizeLocally(f);
    assert.equal(validateActionOnDevice(f.plan, f.observation, f.binding).action.url, url);
  }
  const ordinarySearch = fixture({
    type: 'navigate', url: 'https://example.test/search?q=how%20to%20delete%20drafts'
  });
  assert.equal(validateActionOnDevice(ordinarySearch.plan, ordinarySearch.observation, ordinarySearch.binding).action.type, 'navigate');
});

test('a direct legacy action is accepted with trusted local lease metadata', () => {
  const f = fixture();
  assert.equal(validateActionOnDevice(f.plan.action, f.observation, f.binding).action, f.plan.action);
});

test('tab, window, frame, origin, document, observation, time and navigation epoch are all bound', () => {
  const fields = [
    ['tabId', 9], ['windowId', 9], ['frameId', 1], ['origin', 'https://other.test'],
    ['documentGeneration', 'document-2'], ['observationId', 'observation-2'],
    ['createdMonotonicMs', 999], ['navigationEpoch', 2]
  ];
  for (const [field, value] of fields) {
    const f = fixture();
    f.observation[field] = value;
    assert.throws(() => validateActionOnDevice(f.plan, f.observation, f.binding), new RegExp(field));
  }
});

test('invalid or missing trusted lease fields fail closed', () => {
  for (const [field, value] of [
    ['tabId', -1], ['windowId', 0], ['frameId', -1], ['origin', ''],
    ['documentGeneration', ''], ['observationId', ''],
    ['createdMonotonicMs', NaN], ['navigationEpoch', -1]
  ]) {
    const f = fixture();
    f.binding[field] = value;
    assert.throws(() => validateActionOnDevice(f.plan, f.observation, f.binding), /invalid|incomplete/i);
  }
  const f = fixture();
  delete f.observation.frameId;
  assert.throws(() => validateActionOnDevice(f.plan, f.observation, f.binding), /frameId/);
  const missingUrl = fixture();
  delete missingUrl.binding.url;
  assert.throws(() => validateActionOnDevice(missingUrl.plan, missingUrl.observation, missingUrl.binding), /incomplete observation lease/);
  assert.throws(() => validateActionOnDevice(f.plan, f.observation, null), /missing device task binding/);
});

test('origin must derive from observed URL, and exact URL binding catches same-origin route changes', () => {
  const originShift = fixture();
  originShift.observation.url = 'https://other.test/results';
  assert.throws(() => validateActionOnDevice(originShift.plan, originShift.observation, originShift.binding), /URL\/origin/);

  const sameOrigin = fixture();
  sameOrigin.observation.url = 'https://example.test/changed';
  assert.throws(() => validateActionOnDevice(sameOrigin.plan, sameOrigin.observation, sameOrigin.binding), /URL changed/);

  const injected = fixture();
  injected.observation.url = 'https://example.test@other.test/results';
  assert.throws(() => validateActionOnDevice(injected.plan, injected.observation, injected.binding), /URL\/origin/);
});

test('a planner echo cannot replace the local lease or target metadata', () => {
  for (const [level, field, value] of [
    ['plan', 'observationId', 'stale-observation'],
    ['plan', 'tabId', 99],
    ['action', 'frameId', 10],
    ['action', 'documentGeneration', 'stale-document'],
    ['target', 'origin', 'https://other.test']
  ]) {
    const f = fixture();
    if (level === 'target') f.plan.action.target[field] = value;
    else (level === 'plan' ? f.plan : f.plan.action)[field] = value;
    assert.throws(() => validateActionOnDevice(f.plan, f.observation, f.binding), /mismatch/);
  }
});

test('monotonic clock, expiration, and invalid TTL prevent reuse or future-dated leases', () => {
  for (const [field, value, expected] of [
    ['nowMonotonicMs', 999, /expired|clock/],
    ['nowMonotonicMs', 3001, /expired|clock/],
    ['ttlMs', 0, /invalid TTL/],
    ['ttlMs', ACTION_BINDING_TTL_MS + 1, /invalid TTL/]
  ]) {
    const f = fixture();
    f.binding[field] = value;
    assert.throws(() => validateActionOnDevice(f.plan, f.observation, f.binding), expected);
  }
  const edge = fixture();
  edge.binding.nowMonotonicMs = 3000;
  assert.equal(validateActionOnDevice(edge.plan, edge.observation, edge.binding).action.type, 'click');
});

test('cancel, reload and navigation invalidate before executing even a valid-looking response', () => {
  for (const key of ['cancelled', 'reloaded', 'navigationPending', 'invalidated']) {
    const f = fixture();
    f.binding[key] = true;
    assert.throws(() => validateActionOnDevice(f.plan, f.observation, f.binding), /invalidated|cancelled/);
  }
  for (const reason of ['navigation', 'reload', 'cancel', 'tab-closed', 'frame-detached']) {
    const f = fixture();
    assert.equal(invalidateTaskBinding(f.binding, reason).invalidatedReason, reason);
    assert.throws(() => validateActionOnDevice(f.plan, f.observation, f.binding), /invalidated/);
  }
  const aborted = fixture();
  aborted.binding.abortSignal = { aborted: true };
  assert.throws(() => validateActionOnDevice(aborted.plan, aborted.observation, aborted.binding), /invalidated|cancelled/);
});

test('target reference is a real current cN control, cannot fall back to a semantic selector', () => {
  for (const ref of ['c0', 'c-1', 'c01', '2', '#password', '__proto__', 'c999']) {
    const f = fixture({ type: 'click', target: { ref } });
    assert.throws(() => validateActionOnDevice(f.plan, f.observation, f.binding), /reference|absent/);
  }
  const missing = fixture({ type: 'click' });
  assert.throws(() => validateActionOnDevice(missing.plan, missing.observation, missing.binding), /requires an observed/);
  const hoverMissing = fixture({ type: 'hover' });
  assert.throws(() => validateActionOnDevice(hoverMissing.plan, hoverMissing.observation, hoverMissing.binding), /requires an observed/);
  const hoverUnknown = fixture({ type: 'hover', target: { ref: 'c999' } });
  assert.throws(() => validateActionOnDevice(hoverUnknown.plan, hoverUnknown.observation, hoverUnknown.binding), /absent/);
  const disabled = fixture({ type: 'click', target: { ref: 'c8' } });
  assert.throws(() => validateActionOnDevice(disabled.plan, disabled.observation, disabled.binding), /disabled/);
});

test('sensitive fields reject all remote value actions; valueless local input remains possible', () => {
  for (const type of ['type', 'select', 'press', 'submit']) {
    const f = fixture({ type, target: { ref: 'c2' }, value: 'synthetic' });
    assert.throws(() => validateActionOnDevice(f.plan, f.observation, f.binding), /sensitive field/);
  }
  const accepted = fixture({ type: 'request_local_input', target: { ref: 'c2' }, inputType: 'password' });
  assert.equal(validateActionOnDevice(accepted.plan, accepted.observation, accepted.binding).target.sensitive, true);
  for (const change of [
    { target: { ref: 'c1' } }, { inputType: 'not-a-real-secret-type' }, { value: 'synthetic' },
    { text: 'synthetic' }, { secret: 'synthetic' }, { data: 'synthetic' }
  ]) {
    const f = fixture({ ...accepted.plan.action, ...change });
    assert.throws(() => validateActionOnDevice(f.plan, f.observation, f.binding), /sensitive|unsupported|credential/);
  }
});

test('unknown privacy metadata and password-shaped controls fail remote writes closed', () => {
  for (const edit of [
    target => { delete target.sensitive; },
    target => { target.type = 'password'; },
    target => { target.placeholder = 'Security answer'; },
    target => { target.sensitiveType = 'api-key'; }
  ]) {
    const f = fixture({ type: 'type', target: { ref: 'c7' }, value: 'synthetic public note' });
    edit(f.observation.elements[6]);
    assert.throws(() => validateActionOnDevice(f.plan, f.observation, f.binding), /sensitive field/);
  }
});

test('local secure-input rejects alternate credential-carrying fields at any nested action level', () => {
  for (const change of [
    { payload: { raw: 'synthetic' } },
    { credential: 'synthetic' },
    { metadata: { value: 'synthetic' } },
    { target: { ref: 'c2', value: 'synthetic' } },
    { target: { ref: 'c2', nested: { secret: 'synthetic' } } },
  ]) {
    const f = fixture({ type: 'request_local_input', target: { ref: 'c2' }, inputType: 'password', ...change });
    assert.throws(() => validateActionOnDevice(f.plan, f.observation, f.binding), /credential value or extra fields/);
  }
});

test('unknown action types and malformed operations fail even if planner claims approval', () => {
  for (const action of [
    { type: 'execute_code', target: { ref: 'c1' }, confirmed: true },
    { type: 'media', operation: 'record' },
    { type: 'scroll', direction: 'diagonal' },
    { type: 'wait', ms: 60000 },
    { type: 'navigate', url: 'javascript:alert(1)' },
    { type: 'navigate', url: 'https://user:pass@example.test/public' }
  ]) {
    const f = fixture(action);
    assert.throws(() => validateActionOnDevice(f.plan, f.observation, f.binding), /unsupported|invalid/);
  }
});

test('consequential actions require confirmation recorded only in the local binding', () => {
  for (const action of [
    { type: 'click', target: { ref: 'c3' } },
    { type: 'click', target: { ref: 'c5' } },
    { type: 'click', target: { ref: 'c6' } },
    { type: 'submit', target: { ref: 'c7' } },
    { type: 'press', target: { ref: 'c7' }, key: 'Enter' },
    { type: 'type', target: { ref: 'c7' }, value: 'public', submit: true },
    { type: 'navigate', url: 'https://example.test/checkout' }
  ]) {
    const f = fixture(action);
    f.plan.confirmation = { approved: true, confirmedByLocalUser: true };
    assert.throws(() => validateActionOnDevice(f.plan, f.observation, f.binding), /confirmation/);
    authorizeLocally(f);
    assert.equal(validateActionOnDevice(f.plan, f.observation, f.binding).action, action);
    assert.throws(() => validateActionOnDevice(f.plan, f.observation, f.binding), /confirmation/);
  }
});

test('confirmation is bound to exact action, observation, document and monotonic time', () => {
  for (const mutate of [
    f => { f.plan.action.value = 'changed after approval'; },
    f => { f.binding.confirmation.observationId = 'old-lease'; },
    f => { f.binding.confirmation.documentGeneration = 'old-generation'; },
    f => { f.binding.confirmation.confirmedAtMonotonicMs = 2000; },
    f => { f.binding.confirmation.confirmedByLocalUser = false; },
    f => { f.binding.confirmation.action = { ...f.plan.action }; }
  ]) {
    const f = fixture({ type: 'submit', target: { ref: 'c7' }, value: 'public' });
    authorizeLocally(f);
    mutate(f);
    assert.throws(() => validateActionOnDevice(f.plan, f.observation, f.binding), /confirmation/);
  }
});

test('invalidation consumes an earlier confirmation', () => {
  const f = fixture({ type: 'submit', target: { ref: 'c7' } });
  authorizeLocally(f);
  invalidateTaskBinding(f.binding, 'navigation');
  assert.equal(f.binding.confirmation.consumed, true);
  assert.throws(() => validateActionOnDevice(f.plan, f.observation, f.binding), /invalidated/);
});

test('packaged classic bridge exactly matches canonical module, not a stale security snapshot', async () => {
  const canonical = await readFile(new URL('../extension/action-binding.mjs', import.meta.url), 'utf8');
  const classic = canonical.replace(/^export\s+(?=(?:const|function|async function)\b)/gm, '');
  assert.doesNotMatch(classic, /^\s*export\s/m);
  const expected = `// GENERATED by tools/sync-action-binding.mjs; edit action-binding.mjs instead.\n${classic}\nObject.defineProperty(globalThis, 'CAPTAIN_ACTION_BINDING', { value: Object.freeze({ ACTION_BINDING_TTL_MS, validateActionOnDevice, invalidateTaskBinding }), configurable: false, writable: false });\n`;
  const packaged = await readFile(new URL('../extension/action-binding-runtime.js', import.meta.url), 'utf8');
  assert.equal(packaged, expected, 'regenerate the classic bridge from canonical action-binding.mjs before packaging');
  const sandbox = { URL, performance };
  vm.runInNewContext(packaged, sandbox);
  const gate = sandbox.CAPTAIN_ACTION_BINDING;
  const hover = fixture({ type: 'hover', target: { ref: 'c1' } });
  assert.equal(gate.validateActionOnDevice(hover.plan, hover.observation, hover.binding).action.type, 'hover');
  hover.observation.observationId = 'stale-observation';
  assert.throws(() => gate.validateActionOnDevice(hover.plan, hover.observation, hover.binding), /observationId/);
  const consequential = fixture({ type: 'navigate', url: 'https://example.test/%64elete-account' });
  assert.throws(() => gate.validateActionOnDevice(consequential.plan, consequential.observation, consequential.binding), /confirmation/);
  const localInput = fixture({ type: 'request_local_input', target: { ref: 'c2' }, inputType: 'password', credential: 'synthetic' });
  assert.throws(() => gate.validateActionOnDevice(localInput.plan, localInput.observation, localInput.binding), /extra fields/);
});
