import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

// Source-only test of a fixed-enum diagnostic. No real screenshot or OCR text
// leaves a private worker; the diagnostic does not decide redaction.
const source = await readFile(new URL('../extension/vision-worker.js', import.meta.url), 'utf8');
const sandbox = {
  URL, Number, Set, Math,
  self: { location: { href: 'chrome-extension://synthetic/vision-worker.js' } },
  ort: { env: { wasm: {} } },
  importScripts: () => {}
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(source, sandbox);
const classify = (words, regions = []) => vm.runInContext('auditLowConfidenceScope(words, domPlan, 200, 100)',
  Object.assign(sandbox, { words, domPlan: { regions } }));
const word = (x0, x1, confidence = 70) => ({ text: 'synthetic', confidence,
  bbox: { x0, y0: 10, x1, y1: 20 } });
const mask = { x1: 10, y1: 5, x2: 70, y2: 25 };

test('audit-only OCR scope distinguishes masked/partial/outside uncertainty without payload data', () => {
  assert.equal(classify([word(20, 40)], [mask]), 'COVERED_WORD_IN_MIXED_ROW');
  assert.equal(classify([word(65, 80)], [mask]), 'PARTIAL_MASK_OVERLAP');
  assert.equal(classify([word(100, 130)], [mask]), 'OUTSIDE_MASKS');
  assert.equal(classify([word(20, 40), word(100, 130)], [mask]), 'COVERED_AND_OUTSIDE');
  assert.equal(classify([word(65, 80), word(100, 130)], [mask]), 'PARTIAL_AND_OUTSIDE');
  assert.equal(classify([word(20, 40), word(65, 80), word(100, 130)], [mask]), 'ALL_THREE');
  assert.equal(classify([word(-1, 40)], [mask]), 'INVALID_GEOMETRY');
  assert.equal(classify([word(100, 130, 95)], [mask]), 'NONE');
  assert.equal(classify(null, [mask]), 'UNAVAILABLE');
});

test('worker keeps diagnostic behind opt-in synthetic audit and never changes the row-mask gate', () => {
  assert.match(source, /request\.auditGateOnly === true/);
  assert.match(source, /auditLowConfidenceScope/);
  assert.match(source, /wordsOutsideVerifiedOpaqueMasks/);
  assert.match(source, /ocrPlan\.fullBlackout/);
  assert.doesNotMatch(source, /ocrPlan\.fullBlackout \|\| uiPlan\.fullBlackout/);
  for (const value of ['synthetic@example.test', 'synthetic', 'bbox', 'confidence']) {
    const result = classify([word(100, 130)], [mask]);
    assert.equal(result.includes(value), false);
  }
});
