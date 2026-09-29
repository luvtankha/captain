import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeObservation } from '../server/outbound-contract.mjs';

const sample = () => ({
  task: 'Search the synthetic public catalog',
  context: {
    url: 'https://fixture.example.test/', title: 'Synthetic catalog',
    pageMetadata: {
      domFingerprint: '1234abcd', visibleTextHash: '5678abcd',
      elementCount: 1, meaningfulContent: true, capturedAt: 1000,
    },
    elements: [{
      ref: 'c1', tag: 'input', role: 'combobox', type: 'search',
      name: 'Search catalog', value: 'books', placeholder: 'Search catalog',
      groupText: 'Search publicly listed books', href: '', disabled: false,
      sensitive: false, sensitiveType: '',
      accessibleName: 'Search catalog', associatedLabel: 'Search catalog',
      ariaLabel: 'Search', autocomplete: 'off', inputMode: 'search',
      nearbyText: 'Find a book', framePath: 'top/shadow1/frame1',
      visible: true, enabled: true,
      bbox: { x: 22, y: 58, width: 310, height: 38 },
      state: { checked: false, selected: null, expanded: 'false', readonly: false },
      confidence: 1, source: 'dom',
    }],
  },
});

test('strict outbound contract retains only bounded, reviewed Phase-02 accessibility fields', () => {
  const raw = sample();
  raw.context.interactiveRegions = structuredClone(raw.context.elements);
  const safe = sanitizeObservation(raw);
  for (const field of ['accessibleName','associatedLabel','ariaLabel','autocomplete','inputMode','nearbyText','framePath','visible','enabled']) {
    assert.deepEqual(safe.context.elements[0][field], raw.context.elements[0][field]);
    assert.deepEqual(safe.context.interactiveRegions[0][field], raw.context.interactiveRegions[0][field]);
  }
  assert.equal(safe.context.pageMetadata.documentToken, undefined);
});

test('a device-authorized direct text navigation survives protected history projection', () => {
  const raw = sample();
  raw.history = [{
    action: { type: 'navigate', url: 'https://fixture.example.test/' },
    intent: 'direct-local-navigation', planner: 'local-command',
    reason: 'Navigate before the first protected-page scan.',
    result: { ok: true, navigated: true, navigationMs: 12 },
  }];
  const safe = sanitizeObservation(raw);
  assert.equal(safe.history[0].planner, 'local-command');
  assert.equal(safe.history[0].result.navigated, true);
});

test('opaque document and observation tokens cannot bypass the strict companion contract', () => {
  for (const key of ['documentToken','domRevision','geometryRevision','observationId']) {
    const raw = sample(); raw.context.pageMetadata[key] = 'local-only';
    assert.throws(() => sanitizeObservation(raw), /unexpected field/);
  }
});

test('malformed frame paths, unexpected geometry and private nearby text fail closed', () => {
  for (const mutate of [
    raw => { raw.context.elements[0].framePath = '../../other-origin'; },
    raw => { raw.context.elements[0].geometry = { x: 5 }; },
    raw => { raw.context.elements[0].nearbyText = 'CANARY_private-value'; },
    raw => { raw.context.elements[0].ariaLabel = 'someone@example.com'; },
  ]) {
    const raw = sample(); mutate(raw);
    assert.throws(() => sanitizeObservation(raw), /Outbound contract rejected/);
  }
});
