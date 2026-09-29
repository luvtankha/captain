import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

// Model outputs here are synthetic hand-labelled word fixtures. These tests
// measure privacy decision logic; they are NOT real OCR accuracy measurements.
const [privacySource, geometrySource] = await Promise.all([
  '../extension/privacy/privacy-core.js', '../extension/text/ocr-geometry.js'
].map(path => readFile(new URL(path, import.meta.url), 'utf8')));
const word = (text, confidence = 99, bbox = { x0: 8, y0: 8, x1: 92, y1: 24 }) =>
  ({ text, confidence, bbox });
function harness() {
  const scope = {};
  scope.globalThis = scope;
  vm.createContext(scope);
  vm.runInContext(privacySource, scope);
  vm.runInContext(geometrySource, scope);
  return scope;
}
const review = words => harness().CaptainOCRGeometry.review({ words, width: 160, height: 80 });
const safe = value => JSON.parse(JSON.stringify(value));
const blackout = { fullBlackout: true, regions: [] };

test('typed synthetic email, phone, PAN, account and labelled person are covered by shared PII core', () => {
  for (const value of [
    'canary@example.test', '9123456789', 'ABCDE1234F', '1234 5678 9012',
    'Name: Test Person', 'Password: synthetic-only', 'Bearer synthetic-token-only',
  ]) {
    const result = safe(review([word(value)]));
    assert.equal(result.fullBlackout, false);
    assert.deepEqual(result.regions, [
      { x1: 8, y1: 8, x2: 92, y2: 24, kind: 'PII' }
    ]);
    assert.doesNotMatch(JSON.stringify(result), /canary|example|synthetic|9123456789|ABCDE|Test Person|Bearer/i);
  }
});

test('threshold-confidence ASCII identifiers still use the deterministic local PII scan', () => {
  for (const value of ['canary@example.test', '9123456789', 'ABCDE1234F', '1234 5678 9012']) {
    const result = safe(review([word(value, 40)]));
    assert.deepEqual(result, {
      fullBlackout: false, regions: [{ x1: 8, y1: 8, x2: 92, y2: 24, kind: 'PII' }]
    });
    assert.doesNotMatch(JSON.stringify(result), /canary|example|9123456789|ABCDE|words|bbox|text/i);
  }
});

test('valid but uncertain OCR masks its complete visual run, while malformed confidence still fails closed', () => {
  for (const confidence of [0, 1, 20, 39.99]) {
    assert.deepEqual(safe(review([word('Public heading', confidence)])), {
      fullBlackout: false, regions: [{ x1: 8, y1: 8, x2: 92, y2: 24, kind: 'PII' }]
    });
  }
  for (const confidence of [-1, NaN, Infinity, 101, '99']) {
    assert.deepEqual(safe(review([word('Public heading', confidence)])), blackout);
  }
  assert.deepEqual(safe(review([{ text: 'Public heading',
    bbox: { x0: 8, y0: 8, x1: 92, y1: 24 } }])), blackout);
  assert.deepEqual(safe(review([word('Public heading', 40)])),
    { fullBlackout: false, regions: [] });
});

test('unrecognized scripts and control-like OCR text mask their visual run without exposing it', () => {
  for (const value of ['नमस्ते', '测试文字', 'Привет', 'مرحبا', '🫠', 'public\u200bheading',
    'abc\nprivate', '\u0000', 'é']) {
    assert.deepEqual(safe(review([word(value)])), {
      fullBlackout: false, regions: [{ x1: 8, y1: 8, x2: 92, y2: 24, kind: 'PII' }]
    });
  }
});

test('opaque unknown privacy candidates are redacted by their verified word box', () => {
  const result = safe(review([word('abcd1234abcd1234abcd1234abcd1234')]));
  assert.deepEqual(result, {
    fullBlackout: false, regions: [{ x1: 8, y1: 8, x2: 92, y2: 24, kind: 'PII' }]
  });
  assert.doesNotMatch(JSON.stringify(result), /abcd|words|bbox|text/i);
});

test('one uncertain word masks its local visual run, including neighbouring split text', () => {
  const result = safe(review([
    word('Public', 99, { x0: 8, y0: 8, x1: 55, y1: 24 }),
    word('नमस्ते', 99, { x0: 60, y0: 8, x1: 140, y1: 24 })
  ]));
  assert.deepEqual(result, {
    fullBlackout: false, regions: [{ x1: 8, y1: 8, x2: 140, y2: 24, kind: 'PII' }]
  });
  assert.doesNotMatch(JSON.stringify(result), /Public|नमस्ते|words|bbox|text/i);
});

test('an uncertain visual run does not conceal a distant public column on the same OCR row', () => {
  const result = safe(review([
    word('नमस्ते', 99, { x0: 8, y0: 8, x1: 72, y1: 24 }),
    word('Public', 99, { x0: 120, y0: 8, x1: 155, y1: 24 })
  ]));
  assert.deepEqual(result, {
    fullBlackout: false, regions: [{ x1: 8, y1: 8, x2: 72, y2: 24, kind: 'PII' }]
  });
  assert.doesNotMatch(JSON.stringify(result), /नमस्ते|Public|words|bbox|text/i);
});

test('missing, empty, malformed and excessive OCR words fail closed', () => {
  const scope = harness();
  const geometry = scope.CaptainOCRGeometry;
  for (const words of [
    undefined, null, [], {}, [null], [word('')],
    Array.from({ length: 601 }, () => word('Public heading')),
    [word('x'.repeat(129))],
    [word('private', 99, { x0: 10, y0: 10, x1: 10, y1: 20 })],
    [word('private', 99, { x0: 10, y0: 10, x1: Infinity, y1: 20 })],
  ]) {
    assert.deepEqual(safe(geometry.review({ words, width: 160, height: 80 })), blackout);
  }
});

test('sensitive split tokens crossing word boundaries are masked with no raw mapping', () => {
  const result = safe(review([
    word('canary', 99, { x0: 10, y0: 20, x1: 40, y1: 35 }),
    word('@', 99, { x0: 41, y0: 20, x1: 50, y1: 35 }),
    word('example.test', 99, { x0: 51, y0: 20, x1: 116, y1: 35 }),
  ]));
  assert.equal(result.fullBlackout, false);
  assert.deepEqual(result.regions, [
    { x1: 10, y1: 20, x2: 116, y2: 35, kind: 'PII' }
  ]);
  assert.deepEqual(Object.keys(result), ['fullBlackout', 'regions']);
  assert.deepEqual(Object.keys(result.regions[0]), ['x1', 'y1', 'x2', 'y2', 'kind']);
  assert.doesNotMatch(JSON.stringify(result), /canary|example|words|bbox|ref|mapping/i);
});

test('unsupported scanner, thrown scanner or untrusted getter cannot leak text or errors', () => {
  const scope = harness();
  const privateText = 'canary@example.test';
  const leaked = new Error('secret OCR exception ' + privateText);
  const input = { width: 160, height: 80, words: [word(privateText)] };
  scope.CAPTAIN_PRIVACY = { scanSpans: () => { throw leaked; } };
  assert.deepEqual(safe(scope.CaptainOCRGeometry.review(input)), blackout);
  scope.CAPTAIN_PRIVACY = { scanSpans: () =>
    [{ start: 0, end: privateText.length, type: 'UNREVIEWED' }] };
  assert.deepEqual(safe(scope.CaptainOCRGeometry.review(input)), blackout);
  scope.CAPTAIN_PRIVACY = undefined;
  assert.deepEqual(safe(scope.CaptainOCRGeometry.review(input)), blackout);
  const malicious = { get text() { throw leaked; }, bbox: { x0: 0, y0: 0, x1: 50, y1: 20 },
    confidence: 99 };
  assert.deepEqual(safe(review([malicious])), blackout);
});

test('public words are never sent as OCR observations or actionable element refs', () => {
  const result = safe(review([word('Search'), word('settings', 99,
    { x0: 94, y0: 8, x1: 145, y1: 24 })]));
  assert.deepEqual(result, { fullBlackout: false, regions: [] });
  assert.doesNotMatch(JSON.stringify(result), /Search|settings|c\d+|text|role|source|OCR/i);
});

test('bad OCR region mapped from embedded raster uses only generic blackout result', () => {
  const result = safe(harness().CaptainOCRGeometry.planMasks({
    words: [word('canary@example.test')], width: 160, height: 80,
    space: 'image', viewport: { width: 80, height: 40, devicePixelRatio: 2 },
    surface: {
      kind: 'image', axisAligned: false, intrinsicWidth: 160, intrinsicHeight: 80,
      rect: { x: 0, y: 0, width: 80, height: 40 },
      objectFit: 'fill', objectPositionX: 0.5, objectPositionY: 0.5
    }
  }));
  assert.deepEqual(result, blackout);
  assert.doesNotMatch(JSON.stringify(result), /canary|example|ref|raw/i);
});

test('review and planMasks emit no raw OCR source even when result is inspected deeply', () => {
  const modelWords = [word('canary@example.test')];
  const scope = harness();
  const result = scope.CaptainOCRGeometry.review({ words: modelWords, width: 160, height: 80 });
  const output = JSON.stringify(result);
  for (const fragment of ['canary', 'example.test', 'bbox', 'confidence', 'words', 'ref', 'role',
    'source', 'lineId', 'mapping', 'rawText']) assert.equal(output.includes(fragment), false);
  assert.equal(scope.CaptainOCRGeometry.review.toString().includes('postMessage'), false);
  assert.equal(scope.CaptainOCRGeometry.planMasks.toString().includes('fetch('), false);
});
