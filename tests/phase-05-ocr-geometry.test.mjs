import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

// Synthetic OCR word geometry and CSS surface fixtures. No OCR inference or
// browser screenshot is exercised by these source-only tests.
const [privacySource, geometrySource] = await Promise.all([
  '../extension/privacy/privacy-core.js',
  '../extension/text/ocr-geometry.js',
].map(path => readFile(new URL(path, import.meta.url), 'utf8')));

function engine(withPrivacy = true) {
  const sandbox = {};
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  if (withPrivacy) vm.runInContext(privacySource, sandbox);
  vm.runInContext(geometrySource, sandbox);
  return sandbox.CaptainOCRGeometry;
}
const word = (text, x0, y0, x1, y1, confidence = 99) =>
  ({ text, confidence, bbox: { x0, y0, x1, y1 } });
const source = (words, width = 240, height = 120) => ({ words, width, height });
const viewport = { width: 240, height: 120, devicePixelRatio: 2 };
const screenshot = { width: 480, height: 240 };
function surface(kind, objectFit = 'fill', rect = { x: 10, y: 20, width: 100, height: 50 }) {
  return {
    kind, axisAligned: true, rect, intrinsicWidth: 200, intrinsicHeight: 100,
    objectFit, objectPositionX: 0.5, objectPositionY: 0.5
  };
}
function json(value) { return JSON.parse(JSON.stringify(value)); }

test('source screenshot OCR word geometry maps directly to a PII-only mask', () => {
  const result = json(engine().review(source([word('canary@example.test', 12, 24, 82, 44)])));
  assert.deepEqual(result, {
    fullBlackout: false, regions: [{ x1: 12, y1: 24, x2: 82, y2: 44, kind: 'PII' }]
  });
  assert.doesNotMatch(JSON.stringify(result), /canary|@|words|bbox|text|ref/i);
});

test('split OCR words on one line combine across gaps into one private pixel mask', () => {
  const result = json(engine().review(source([
    word('example.test', 65, 20, 115, 33),
    word('canary', 10, 20, 48, 33),
    word('@', 50, 20, 62, 33),
  ])));
  assert.deepEqual(result.regions, [{ x1: 10, y1: 20, x2: 115, y2: 33, kind: 'PII' }]);
  assert.equal(result.fullBlackout, false);
});

test('multiple overlapping or nested OCR masks union while disjoint lines remain separate', () => {
  const result = json(engine().review(source([
    word('canary@example.test', 10, 20, 110, 35),
    word('canary@example.test', 20, 22, 80, 32),
    word('canary@example.test', 120, 20, 200, 35),
    word('canary@example.test', 10, 60, 110, 75),
  ])));
  assert.equal(result.fullBlackout, false);
  assert.deepEqual(result.regions, [
    // Conservative compact-line scan can bridge adjacent private text groups.
    { x1: 10, y1: 20, x2: 200, y2: 35, kind: 'PII' },
    { x1: 10, y1: 60, x2: 110, y2: 75, kind: 'PII' }
  ]);
});

test('bounded split account digits and labelled names are recognized by shared Phase-03 scanner', () => {
  const result = json(engine().review(source([
    word('Account:', 10, 12, 65, 23),
    word('1234', 68, 12, 96, 23),
    word('5678', 97, 12, 125, 23),
    word('9012', 126, 12, 154, 23),
    word('Name:', 10, 50, 45, 61),
    word('Test', 48, 50, 74, 61),
    word('Person', 76, 50, 113, 61),
  ])));
  assert.equal(result.fullBlackout, false);
  assert.deepEqual(result.regions, [
    { x1: 68, y1: 12, x2: 154, y2: 23, kind: 'PII' },
    { x1: 48, y1: 50, x2: 113, y2: 61, kind: 'PII' }
  ]);
});

test('canvas backing pixels map through independently scaled CSS box and screenshot DPR', () => {
  const result = json(engine().planMasks({
    words: [word('canary@example.test', 20, 10, 60, 30)],
    space: 'canvas', surface: surface('canvas'), viewport, ...screenshot
  }));
  assert.deepEqual(result.regions, [{ x1: 40, y1: 50, x2: 80, y2: 70, kind: 'PII' }]);
  assert.equal(result.fullBlackout, false);
});

test('embedded screenshot image object-fit contain accounts for letterboxing', () => {
  const result = json(engine().planMasks({
    words: [word('canary@example.test', 20, 10, 60, 30)],
    space: 'image', surface: surface('image', 'contain',
      { x: 10, y: 20, width: 100, height: 100 }), viewport, ...screenshot
  }));
  assert.deepEqual(result.regions, [{ x1: 40, y1: 100, x2: 80, y2: 120, kind: 'PII' }]);
});

test('embedded screenshot image object-fit cover crops source pixels at CSS boundary', () => {
  const result = json(engine().planMasks({
    words: [word('canary@example.test', 0, 10, 120, 50)],
    space: 'image', surface: surface('image', 'cover',
      { x: 10, y: 20, width: 100, height: 100 }), viewport, ...screenshot
  }));
  assert.deepEqual(result.regions, [{ x1: 20, y1: 60, x2: 160, y2: 140, kind: 'PII' }]);
});

test('object-fit none and scale-down keep intrinsic pixel coordinates and center offsets', () => {
  const ocr = word('canary@example.test', 80, 40, 120, 60);
  const base = { words: [ocr], space: 'raster', viewport, ...screenshot };
  const none = json(engine().planMasks({ ...base, surface: surface('raster', 'none') }));
  assert.deepEqual(none.regions, [{ x1: 80, y1: 70, x2: 160, y2: 110, kind: 'PII' }]);
  const scaleDown = json(engine().planMasks({ ...base, surface: surface('raster', 'scale-down') }));
  assert.deepEqual(scaleDown.regions, [{ x1: 100, y1: 80, x2: 140, y2: 100, kind: 'PII' }]);
});

test('unmappable surface, transform, pixel scale or invisible crop forces blackout', () => {
  const good = { words: [word('canary@example.test', 20, 10, 60, 30)],
    space: 'image', surface: surface('image'), viewport, ...screenshot };
  const bad = [
    { surface: { ...good.surface, axisAligned: false } },
    { surface: { ...good.surface, objectFit: 'unreviewed' } },
    { surface: { ...good.surface, objectPositionX: Infinity } },
    { surface: { ...good.surface, intrinsicWidth: NaN } },
    { surface: { ...good.surface, rect: { ...good.surface.rect, width: 0 } } },
    { surface: surface('image', 'cover', { x: 500, y: 500, width: 100, height: 100 }) },
    { viewport: { ...viewport, devicePixelRatio: 1 } },
    { space: 'canvas' },
    { space: 'untrusted' },
  ];
  for (const change of bad) assert.deepEqual(json(engine().planMasks({ ...good, ...change })),
    { fullBlackout: true, regions: [] });
});

test('unknown source coordinate, wrong dimensions and absent scanner fail closed', () => {
  for (const input of [
    source([word('canary@example.test', -1, 10, 60, 30)]),
    source([word('canary@example.test', 1, 1, 241, 20)]),
    source([word('canary@example.test', 1, 1, 60, 20)], 0, 120),
    source([word('canary@example.test', 1, 1, 60, 20)], 5000, 5000),
  ]) assert.deepEqual(json(engine().review(input)), { fullBlackout: true, regions: [] });
  assert.deepEqual(json(engine(false).review(source([
    word('canary@example.test', 1, 1, 60, 20)
  ]))), { fullBlackout: true, regions: [] });
});
