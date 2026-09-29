import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../extension/service-worker.js', import.meta.url), 'utf8');
const originalMetadata = () => ({
  documentToken: 'local-document-opaque', domRevision: 4,
  geometryRevision: 2, observationId: 'local-observation-opaque',
  domFingerprint: 'd1a2b3c4', visibleTextHash: 'e1a2b3c4',
  elementCount: 1, meaningfulContent: true, capturedAt: 1000,
});
function harness() {
  let fresh = null, checked = 0, invalidated = 0;
  const sandbox = {
    URL, performance, AbortController, setTimeout, clearTimeout,
    CAPTAIN_ACTION_BINDING: {
      validateActionOnDevice(_plan, _observation, lease) { checked++; return { action: _plan.action, lease }; },
      invalidateTaskBinding(lease) { invalidated++; lease.invalidated = true; },
    },
    chrome: {
      runtime: { id: 'captain-synthetic-test', onMessage: { addListener() {} } },
      tabs: {
        get: async () => ({ id: 7, windowId: 3, incognito: true, url: 'https://fixture.example/' }),
        sendMessage: async () => fresh,
      },
    },
  };
  vm.runInNewContext(source, sandbox);
  const tab = { id: 7, windowId: 3, incognito: true, url: 'https://fixture.example/' };
  const context = metadata => ({
    url: tab.url, pageMetadata: metadata,
    elements: [{ ref: 'c1', sensitive: false, disabled: false }],
  });
  const plan = { action: { type: 'click', target: { ref: 'c1' } } };
  return {
    sandbox, tab, context, plan,
    setFresh(value) { fresh = value; },
    get checked() { return checked; },
    get invalidated() { return invalidated; },
  };
}

test('opaque page identity and revision are device-only; model context retains public fingerprints', () => {
  const { sandbox, context, tab } = harness();
  const original = context(originalMetadata());
  const projected = JSON.parse(JSON.stringify(sandbox.plannerContext(original)));
  assert.deepEqual(projected.pageMetadata, {
    domFingerprint: 'd1a2b3c4', visibleTextHash: 'e1a2b3c4',
    elementCount: 1, meaningfulContent: true, capturedAt: 1000,
  });
  assert.equal(original.pageMetadata.documentToken, 'local-document-opaque');
  const lease = sandbox.mintLocalActionLease(tab, original, 1);
  assert.equal(lease.documentGeneration, 'local-document-opaque');
});

test('local screenshot scroll offsets never enter the planner projection', () => {
  const { sandbox, context } = harness();
  const original = { ...context(originalMetadata()), viewport: {
    width: 1280, height: 720, devicePixelRatio: 1.25, scrollX: 18, scrollY: 900,
  } };
  const projected = JSON.parse(JSON.stringify(sandbox.plannerContext(original)));
  assert.deepEqual(projected.viewport, { width: 1280, height: 720, devicePixelRatio: 1.25 });
  assert.equal(projected.viewport.scrollX, undefined);
  assert.equal(projected.viewport.scrollY, undefined);
});

test('matching second observation binds the exact locally generated execution guard', async () => {
  const h = harness(), metadata = originalMetadata();
  const first = h.context(metadata);
  h.setFresh(h.context({ ...metadata, observationId: 'fresh-observation-opaque' }));
  const lease = h.sandbox.mintLocalActionLease(h.tab, first, 1);
  await h.sandbox.validatePlannedActionOnDevice(h.plan, first, h.tab, lease);
  assert.equal(h.checked, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(lease.executionGuard)), {
    documentToken: metadata.documentToken, domRevision: metadata.domRevision,
    geometryRevision: metadata.geometryRevision, observationId: 'fresh-observation-opaque',
  });
});

test('real extension refuses missing document identity instead of falling back to a DOM fingerprint', async () => {
  const h = harness(), first = h.context({ domFingerprint: 'd1a2b3c4' });
  h.setFresh(h.context(originalMetadata()));
  const lease = h.sandbox.mintLocalActionLease(h.tab, first, 1);
  await assert.rejects(h.sandbox.validatePlannedActionOnDevice(h.plan, first, h.tab, lease), /identity is unavailable/);
  assert.equal(h.checked, 0);
  assert.equal(h.invalidated, 1);
});

for (const [name, change] of [
  ['same-URL document replacement', { documentToken: 'another-document-token' }],
  ['same-looking actionable DOM mutation', { domRevision: 5 }],
  ['scroll, zoom or resize geometry change', { geometryRevision: 3 }],
]) {
  test(`${name} fails closed even with the same visible fingerprint`, async () => {
    const h = harness(), metadata = originalMetadata(), first = h.context(metadata);
    h.setFresh(h.context({ ...metadata, ...change, observationId: 'fresh-observation-opaque' }));
    const lease = h.sandbox.mintLocalActionLease(h.tab, first, 1);
    await assert.rejects(h.sandbox.validatePlannedActionOnDevice(h.plan, first, h.tab, lease), /Page changed while planning/);
    assert.equal(h.checked, 0);
    assert.equal(h.invalidated, 1);
  });
}
