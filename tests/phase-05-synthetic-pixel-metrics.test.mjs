import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

// Deliberately labelled synthetic OCR WORD BOXES, not measured model OCR,
// outgoing JPEG margin, independent browser screenshot or PII recall.
const [privacy, geometry] = await Promise.all([
  '../extension/privacy/privacy-core.js', '../extension/text/ocr-geometry.js'
].map(path => readFile(new URL(path, import.meta.url), 'utf8')));
const W = 200, H = 100;
const truths = [
  { x1: 10, y1: 10, x2: 80, y2: 30 },  // synthetic email = 1400 pixels
  { x1: 120, y1: 50, x2: 180, y2: 70 } // synthetic phone = 1200 pixels
];
const words = [
  { text: 'canary@example.test', confidence: 99, bbox: { x0: 10, y0: 10, x1: 80, y1: 30 } },
  { text: 'Search', confidence: 99, bbox: { x0: 90, y0: 10, x1: 118, y1: 30 } },
  { text: '9123456789', confidence: 99, bbox: { x0: 120, y0: 50, x1: 180, y1: 70 } }
];
const inside = (x, y, box) => x >= box.x1 && x < box.x2 && y >= box.y1 && y < box.y2;
const result = item => JSON.parse(JSON.stringify(item));
function maskPlan(inputWords) {
  const scope = {}; scope.globalThis = scope; vm.createContext(scope);
  vm.runInContext(privacy, scope); vm.runInContext(geometry, scope);
  return result(scope.CaptainOCRGeometry.review({ words: inputWords, width: W, height: H }));
}
function confusion(plan) {
  const counts = { truePositive: 0, falsePositive: 0, falseNegative: 0, trueNegative: 0 };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const labelledPrivate = truths.some(box => inside(x, y, box));
    const masked = plan.fullBlackout || plan.regions.some(box => inside(x, y, box));
    if (labelledPrivate && masked) counts.truePositive++;
    else if (!labelledPrivate && masked) counts.falsePositive++;
    else if (labelledPrivate) counts.falseNegative++;
    else counts.trueNegative++;
  }
  return counts;
}

test('labelled synthetic OCR-box privacy geometry has explicit pixel precision and recall denominators', () => {
  const plan = maskPlan(words);
  assert.equal(plan.fullBlackout, false);
  const counts = confusion(plan);
  // Conservative compact-word scanning also covers 760 adjacent public pixels;
  // report this overmask rather than claiming unrealistic perfect precision.
  assert.deepEqual(counts, { truePositive: 2600, falsePositive: 760, falseNegative: 0, trueNegative: 16640 });
  assert.equal(counts.truePositive / (counts.truePositive + counts.falsePositive), 2600 / 3360);
  assert.equal(counts.truePositive / (counts.truePositive + counts.falseNegative), 1);
});

test('uncertain OCR masks only its local visual run with labelled 100% synthetic coverage', () => {
  const plan = maskPlan(words.map((word, index) => index === 0 ? { ...word, confidence: 20 } : word));
  assert.deepEqual(plan, { fullBlackout: false, regions: [
    { x1: 10, y1: 10, x2: 118, y2: 30, kind: 'PII' },
    { x1: 120, y1: 50, x2: 180, y2: 70, kind: 'PII' }
  ] });
  const counts = confusion(plan);
  assert.deepEqual(counts, { truePositive: 2600, falsePositive: 760, falseNegative: 0, trueNegative: 16640 });
  assert.equal(counts.truePositive / (counts.truePositive + counts.falsePositive), 2600 / 3360);
  assert.equal(counts.truePositive / (counts.truePositive + counts.falseNegative), 1);
});
