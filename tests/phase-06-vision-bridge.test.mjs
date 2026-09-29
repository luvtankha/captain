import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { createHash, webcrypto } from 'node:crypto';

// Actual visual-worker source, real fusion module, synthetic pixels and a
// MOCKED future model adapter. This is explicitly NOT pretrained inference.
const [core, fusion, worker] = await Promise.all([
  '../extension/vision-core.js', '../extension/controls/ui-fusion.js',
  '../extension/vision-worker.js'
].map(path => readFile(new URL(path, import.meta.url), 'utf8')));
const W = 96, H = 48, MODEL = 'a'.repeat(64);
const FACE_SHA = 'd7c687949526065ab6a192fdf993360045ce27b0fabf7c9fca5c2437b786b495';
const lease = { documentToken: 'doc-abcdef12345', observationId: 'obs-abcdef12345', domRevision: 1, geometryRevision: 1 };
const box = { x1: 10, y1: 10, x2: 30, y2: 25 };
const snapshot = { lease, controls: [{ ref: 'c2', source: 'dom', visible: true, enabled: true,
  sensitive: true, box: { x: 10, y: 10, width: 20, height: 15 }, lease }] };

function harness({ active = true, kind = 'matched', ocrBlackout = false } = {}) {
  const messages = [], original = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < original.length; i += 4) original.set([213, 47, 63, 255], i);
  const source = { width: W, height: H, pixels: original };
  class Canvas {
    constructor(width, height) {
      this.width = width; this.height = height;
      this.pixels = new Uint8ClampedArray(width * height * 4);
      for (let i = 3; i < this.pixels.length; i += 4) this.pixels[i] = 255;
    }
    getContext() {
      const canvas = this;
      return {
        fillStyle: '#09090b',
        drawImage(image) {
          for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
            const from = (Math.min(image.height - 1, Math.floor(y * image.height / canvas.height)) * image.width +
              Math.min(image.width - 1, Math.floor(x * image.width / canvas.width))) * 4;
            canvas.pixels.set(image.pixels.subarray(from, from + 4), (y * canvas.width + x) * 4);
          }
        },
        fillRect(x, y, width, height) {
          assert.equal(this.fillStyle, '#09090b');
          for (let row = y; row < y + height; row++) for (let col = x; col < x + width; col++)
            canvas.pixels.set([9, 9, 11, 255], (row * canvas.width + col) * 4);
        },
        getImageData() { return { width: canvas.width, height: canvas.height, data: canvas.pixels }; }
      };
    }
    async convertToBlob() {
      const bytes = new Uint8Array(3 + this.width * this.height * 3 + 2);
      bytes.set([255, 216, 255]);
      for (let i = 0, at = 3; i < this.pixels.length; i += 4, at += 3)
        bytes.set(this.pixels.subarray(i, i + 3), at);
      bytes.set([255, 217], bytes.length - 2);
      return { type: 'image/jpeg', size: bytes.length, width: this.width,
        height: this.height, pixels: this.pixels, arrayBuffer: async () => bytes.buffer };
    }
  }
  let called = 0;
  const detection = { complete: true, source: 'ui-element-onnx', modelSha256: MODEL,
    width: W, height: H, lease, detections: [{ kind: 'control', confidence: 0.92, box }] };
  const model = { ready: active, modelSha256: MODEL, async detect() {
    called++;
    if (kind === 'throw') throw new Error('private-model-error canary@example.test');
    if (kind === 'timeout') return new Promise(() => {});
    if (kind === 'model-only') return { ...detection, detections: [{ kind: 'control', confidence: 0.92,
      box: { x1: 48, y1: 10, x2: 68, y2: 25 } }] };
    if (kind === 'stale') return { ...detection, lease: { ...lease, domRevision: 2 } };
    if (kind === 'private-output') return { ...detection, detections: [{ ...detection.detections[0],
      text: 'canary@example.test' }] };
    return detection;
  } };
  const sandbox = {
    URL, Float32Array, Uint8Array, Uint8ClampedArray, ArrayBuffer, Math, Number,
    performance: { now: () => 5 }, setTimeout: kind === 'timeout'
      ? (callback, ms, ...args) => ms === 8000 ? (callback(), 1) : setTimeout(callback, ms, ...args)
      : setTimeout,
    clearTimeout, OffscreenCanvas: Canvas,
    btoa: value => Buffer.from(value, 'binary').toString('base64'),
    crypto: { subtle: { digest: (_algorithm, bytes) => bytes.byteLength === 100_001 ?
      Uint8Array.from(Buffer.from(FACE_SHA, 'hex')).buffer : webcrypto.subtle.digest('SHA-256', bytes) } },
    fetch: async value => String(value).endsWith('.onnx') ?
      { ok: true, arrayBuffer: async () => new ArrayBuffer(100_001) } :
      { ok: true, blob: async () => ({ type: 'image/jpeg', size: 200 }) },
    createImageBitmap: async blob => blob.pixels ?
      { width: blob.width, height: blob.height, pixels: blob.pixels, close() {} } : source,
    ort: { env: { wasm: {} }, Tensor: class { constructor(type, data, dims) { Object.assign(this, { type, data, dims }); } },
      InferenceSession: { create: async () => ({ inputNames: ['input'], run: async () => ({
        scores: { type: 'float32', dims: [1, 1, 2], data: new Float32Array([0.99, 0.01]) },
        boxes: { type: 'float32', dims: [1, 1, 4], data: new Float32Array([0.2, 0.2, 0.4, 0.4]) }
      }) }) } },
    CaptainUIModel: model, CaptainLocalOCR: { ready: true, recognize: async () => ({ complete: true, words: [] }) },
    CaptainOCRGeometry: { review: () => ({ fullBlackout: ocrBlackout, regions: [] }) },
    CAPTAIN_PRIVACY: { scanSpans: () => [] },
    self: { location: { href: 'chrome-extension://synthetic/vision-worker.js' }, postMessage: data => messages.push(data) },
    importScripts: () => {}
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const script of [core, fusion, worker]) vm.runInContext(script, sandbox);
  return { called: () => called, async run(uiSnapshot = snapshot) {
    await sandbox.self.onmessage({ data: { id: 6,
      screenshot: 'data:image/jpeg;base64,' + Buffer.alloc(120, 42).toString('base64'),
      viewport: { width: W, height: H, devicePixelRatio: 1 }, redactionBoxes: [], uiSnapshot } });
    return messages.at(-1);
  } };
}
function pixel(message, x, y) {
  assert.equal(message.ok, true, message.error);
  const bytes = Buffer.from(message.result.screenshot.split(',')[1], 'base64');
  assert.equal(createHash('sha256').update(bytes).digest('hex'), message.result.visualPrivacy.imageSha256);
  return [...bytes.subarray(3 + (y * W + x) * 3, 3 + (y * W + x) * 3 + 3)];
}

test('disabled bridge is never called, and legacy mask/proof path remains intact', async () => {
  const fixture = harness({ active: false }), message = await fixture.run();
  assert.equal(fixture.called(), 0);
  assert.deepEqual(pixel(message, 50, 30), [9, 9, 11]); // Existing no-mask fail-black.
  assert.equal(message.result.visualPrivacy.schema, 'captain.visual-privacy.v2');
});
test('mocked genuine-DOM match widens sensitive pixel mask without leaking model details', async () => {
  const fixture = harness(), message = await fixture.run();
  assert.equal(fixture.called(), 1);
  assert.deepEqual(pixel(message, 20, 17), [9, 9, 11]);
  assert.deepEqual(pixel(message, 60, 30), [213, 47, 63]);
  assert.doesNotMatch(JSON.stringify(message), /matchedRefs|detections|modelSha256.*a{64}|canary@example/);
});
for (const kind of ['model-only', 'stale', 'private-output', 'throw', 'timeout']) {
  test(`mocked ${kind} cannot authorize unmasked outgoing screenshot or private error`, async () => {
    const message = await harness({ kind }).run();
    assert.deepEqual(pixel(message, 0, 0), [9, 9, 11]);
    assert.deepEqual(pixel(message, W - 1, H - 1), [9, 9, 11]);
    assert.equal(message.result.visualPrivacy.pixelMaskCount, 1);
    assert.doesNotMatch(JSON.stringify(message), /canary@example|private-model-error|detections/);
  });
}
test('missing local snapshot fails closed under a detector marked ready', async () => {
  const message = await harness().run(undefined);
  // run(undefined) uses its default; explicitly give an empty object.
  assert.equal(message.ok, true);
  const invalid = await harness().run({});
  assert.deepEqual(pixel(invalid, 0, 0), [9, 9, 11]);
});
test('OCR uncertainty skips costly optional UI inference while preserving opaque JPEG proof', async () => {
  const fixture = harness({ ocrBlackout: true });
  const message = await fixture.run();
  assert.equal(fixture.called(), 0);
  assert.deepEqual(pixel(message, 0, 0), [9, 9, 11]);
  assert.deepEqual(pixel(message, W - 1, H - 1), [9, 9, 11]);
  assert.equal(message.result.visualPrivacy.coverageVerified, true);
});
test('absent or empty DOM snapshot skips optional inference without releasing pixels', async () => {
  for (const snapshot of [null, {}, { lease, controls: [] }]) {
    const fixture = harness(), message = await fixture.run(snapshot);
    assert.equal(fixture.called(), 0);
    assert.deepEqual(pixel(message, 0, 0), [9, 9, 11]);
    assert.deepEqual(pixel(message, W - 1, H - 1), [9, 9, 11]);
  }
});
