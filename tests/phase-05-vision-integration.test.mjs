import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { createHash, webcrypto } from 'node:crypto';
import { context as alternativeContext } from './helpers/phase-07-alternative-harness.mjs';

// This is a synthetic-pixel integration fixture, NOT Tesseract inference or a
// real browser screenshot.  It runs the actual visual worker and OCR geometry
// with a deliberately explicit local OCR model stub.
const [privacy, geometry, visionCore, visionWorker] = await Promise.all([
  '../extension/privacy/privacy-core.js',
  '../extension/text/ocr-geometry.js',
  '../extension/vision-core.js',
  '../extension/vision-worker.js',
].map(path => readFile(new URL(path, import.meta.url), 'utf8')));
const WIDTH = 96, HEIGHT = 48;
const BLACK = [9, 9, 11], SOURCE = [213, 47, 63];
const MODEL_SHA = 'd7c687949526065ab6a192fdf993360045ce27b0fabf7c9fca5c2437b786b495';

function harness(ocr = 'pii', trueSight = null, alternative = null) {
  const messages = [];
  const original = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
  for (let i = 0; i < original.length; i += 4) original.set([...SOURCE, 255], i);
  const source = { width: WIDTH, height: HEIGHT, pixels: original };
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
            canvas.pixels.set([...BLACK, 255], (row * canvas.width + col) * 4);
        },
        getImageData(x, y, width, height) {
          const data = new Uint8ClampedArray(width * height * 4);
          for (let row = 0; row < height; row++) for (let col = 0; col < width; col++) {
            const from = ((row + y) * canvas.width + col + x) * 4;
            data.set(canvas.pixels.subarray(from, from + 4), (row * width + col) * 4);
          }
          return { width, height, data };
        },
      };
    }
    async convertToBlob() {
      const bytes = new Uint8Array(3 + this.width * this.height * 3 + 2);
      bytes.set([255, 216, 255]);
      for (let i = 0, at = 3; i < this.pixels.length; i += 4, at += 3)
        bytes.set(this.pixels.subarray(i, i + 3), at);
      bytes.set([255, 217], bytes.length - 2);
      return { type: 'image/jpeg', size: bytes.length, pixels: this.pixels,
        width: this.width, height: this.height, arrayBuffer: async () => bytes.buffer };
    }
  }
  const recognize = async () => {
    if (ocr === 'throw') throw new Error('synthetic raw OCR error canary@example.test');
    if (ocr === 'incomplete') return { complete: false, words: [] };
    if (ocr === 'empty') return { complete: true, words: [] };
    if (ocr === 'low') return { complete: true, words: [
      { text: 'public', confidence: 1, bbox: { x0: 13, y0: 12, x1: 43, y1: 22 } },
    ] };
    if (ocr === 'covered-low' || ocr === 'partial-low' || ocr === 'beyond-low' || ocr === 'covered-only' || ocr === 'shared-low') return {
      complete: true, words: [
        ...(ocr === 'covered-only' ? [] : [
          { text: 'public', confidence: 99, bbox: { x0: 13,
            y0: ocr === 'shared-low' ? 12 : 28,
            x1: 43, y1: ocr === 'shared-low' ? 22 : 38 } }]),
        { text: 'unreadable', confidence: 20, bbox: {
          x0: ocr === 'beyond-low' ? 68 : ocr === 'partial-low' ? 72 : 78,
          y0: 14, x1: 85, y1: 21 } }
      ]
    };
    if (ocr === 'bad') return { complete: true, words: [
      { text: 'canary@example.test', confidence: 98, bbox: { x0: NaN, y0: 12, x1: 43, y1: 22 } },
    ] };
    if (ocr === 'public') return { complete: true, words: [
      { text: 'Alex', confidence: 99, bbox: { x0: 13, y0: 12, x1: 43, y1: 22 } },
    ] };
    if (ocr === 'greeting') return { complete: true, words: [
      { text: 'Hello', confidence: 99, bbox: { x0: 13, y0: 12, x1: 43, y1: 22 } },
      { text: 'world.', confidence: 99, bbox: { x0: 45, y0: 12, x1: 70, y1: 22 } },
    ] };
    return { complete: true, words: [
      { text: 'canary@example.test', confidence: 99, bbox: { x0: 13, y0: 12, x1: 43, y1: 22 } },
    ] };
  };
  const sandbox = {
    URL, Float32Array, Uint8Array, Uint8ClampedArray, ArrayBuffer, Math, Number,
    setTimeout, clearTimeout,
    performance: { now: () => 5 }, OffscreenCanvas: Canvas,
    btoa: text => Buffer.from(text, 'binary').toString('base64'),
    crypto: { subtle: { digest: (algorithm, bytes) => bytes.byteLength === 100_001 ?
      Uint8Array.from(Buffer.from(MODEL_SHA, 'hex')).buffer : webcrypto.subtle.digest(algorithm, bytes) } },
    fetch: async url => String(url).endsWith('.onnx') ?
      { ok: true, arrayBuffer: async () => new ArrayBuffer(100_001) } :
      { ok: true, blob: async () => ({ type: 'image/jpeg', size: 200 }) },
    createImageBitmap: async blob => blob.pixels ?
      { width: blob.width, height: blob.height, pixels: blob.pixels, close() {} } : source,
    ort: { env: { wasm: {} }, Tensor: class { constructor(type, data, dims) { Object.assign(this, { type, data, dims }); } },
      InferenceSession: { create: async () => ({ inputNames: ['input'], run: async () => ({
        scores: { type: 'float32', dims: [1, 1, 2], data: new Float32Array([0.99, 0.01]) },
        boxes: { type: 'float32', dims: [1, 1, 4], data: new Float32Array([0.2, 0.2, 0.4, 0.4]) },
      }) }) } },
    CaptainLocalOCR: ocr === 'missing' ? undefined : { ready: true, recognize },
    CaptainTrueSight: trueSight,
    CaptainAlternativePII: alternative,
    self: { location: { href: 'chrome-extension://synthetic/vision-worker.js' }, postMessage: message => messages.push(message) },
    importScripts: () => {},
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const script of [privacy, geometry, visionCore, visionWorker]) vm.runInContext(script, sandbox);
  async function run(request = {}) {
    await sandbox.self.onmessage({ data: {
      id: 9, screenshot: 'data:image/jpeg;base64,' + Buffer.alloc(120, 42).toString('base64'),
      viewport: { width: WIDTH, height: HEIGHT, devicePixelRatio: 1 },
      redactionBoxes: [{ x: 77, y: 12, width: 9, height: 12, kind: 'RASTER_CONTENT' }],
      ...request,
    } });
    return messages.at(-1);
  }
  return { run };
}

function pixel(message, x, y) {
  assert.equal(message.ok, true, message.error);
  const bytes = Buffer.from(message.result.screenshot.split(',')[1], 'base64');
  assert.equal(createHash('sha256').update(bytes).digest('hex'), message.result.visualPrivacy.imageSha256);
  return [...bytes.subarray(3 + (y * WIDTH + x) * 3, 3 + (y * WIDTH + x) * 3 + 3)];
}

test('mocked OCR PII is an opaque outgoing JPEG pixel region and raw text never escapes the worker', async () => {
  const result = await harness('pii').run();
  assert.deepEqual(pixel(result, 23, 17), BLACK);
  assert.deepEqual(pixel(result, 80, 18), BLACK); // Pre-existing whole raster mask.
  assert.deepEqual(pixel(result, 56, 28), SOURCE); // Public pixel survives; not a fake full-frame pass.
  assert.equal(result.result.visualPrivacy.schema, 'captain.visual-privacy.v2');
  assert.equal(result.result.visualPrivacy.pixelMaskCount, 2);
  assert.doesNotMatch(JSON.stringify(result), /canary@example\.test|words|bbox|raw OCR/i);
});

for (const mode of ['missing', 'throw', 'incomplete', 'empty', 'bad']) {
  test(`mocked OCR ${mode} cannot authorize an unmasked screenshot`, async () => {
    const result = await harness(mode).run();
    assert.deepEqual(pixel(result, 0, 0), BLACK);
    assert.deepEqual(pixel(result, WIDTH - 1, HEIGHT - 1), BLACK);
    assert.equal(result.result.visualPrivacy.pixelMaskCount, 1);
    assert.doesNotMatch(JSON.stringify(result), /canary@example\.test|synthetic raw OCR error/i);
  });
}

test('low-confidence OCR masks its visual run and leaves unrelated pixels available in the proof', async () => {
  const result = await harness('low').run();
  assert.deepEqual(pixel(result, 23, 17), BLACK);
  assert.deepEqual(pixel(result, 80, 18), BLACK); // Existing DOM/raster mask.
  assert.deepEqual(pixel(result, 0, 0), SOURCE);
  assert.deepEqual(pixel(result, 60, 35), SOURCE);
  assert.equal(result.result.visualPrivacy.pixelMaskCount, 2);
  assert.doesNotMatch(JSON.stringify(result), /public|words|bbox|confidence/i);
});

test('low-confidence OCR fully inside an independently opaque raster stays hidden while public pixels survive', async () => {
  const result = await harness('covered-low').run();
  assert.deepEqual(pixel(result, 80, 18), BLACK);
  assert.deepEqual(pixel(result, 56, 28), SOURCE);
  assert.equal(result.result.visualPrivacy.pixelMaskCount, 1);
  assert.equal(result.result.visualPrivacy.coverageVerified, true);
  assert.doesNotMatch(JSON.stringify(result), /unreadable|public|words|bbox/i);
});

for (const [name, mode, request, masks] of [
  ['word inside only the unverified outer JPEG mask buffer', 'partial-low', {}, 2],
  ['word extending outside the painted raster mask', 'beyond-low', {}, 2],
  ['absent raster mask', 'covered-low', { redactionBoxes: [] }, 1],
  ['all recognized words already covered by DOM masks', 'covered-only', {}, 1]
]) test(`${name} masks the uncertain OCR visual run without blacking unrelated pixels`, async () => {
  const result = await harness(mode).run(request);
  assert.deepEqual(pixel(result, 80, 18), BLACK);
  assert.deepEqual(pixel(result, 0, 0), SOURCE);
  assert.deepEqual(pixel(result, 45, 30), SOURCE);
  assert.equal(result.result.visualPrivacy.pixelMaskCount, masks);
});

test('a covered low-confidence word in a distant visual run does not mask public content sharing its OCR row', async () => {
  const result = await harness('shared-low').run();
  assert.deepEqual(pixel(result, 56, 17), SOURCE);
  assert.deepEqual(pixel(result, 56, 40), SOURCE);
  assert.equal(result.result.visualPrivacy.pixelMaskCount, 2);
});

test('unknown DOM raster geometry still withholds every source pixel', async () => {
  const result = await harness('covered-low').run({ redactionBoxes: [{ x: 77, y: 12, width: 9, height: 12, kind: 'UNKNOWN' }] });
  assert.deepEqual(pixel(result, 0, 0), BLACK);
  assert.deepEqual(pixel(result, WIDTH - 1, HEIGHT - 1), BLACK);
  assert.equal(result.result.visualPrivacy.pixelMaskCount, 1);
});

// Phase 07: synthetic pixels and deliberately injected NER predictions. This
// exercises the actual outbound mask/JPEG verification path, NOT trained model
// inference; production TrueSight remains disabled until matching assets exist.
test('Phase 07 injected local NER region only adds an opaque outgoing pixel mask', async () => {
  const result = await harness('public', {
    ready: true,
    detect: async () => ({ complete: true }),
    review: () => ({ fullBlackout: false, regions: [{ x1: 13, y1: 12, x2: 43, y2: 22, kind: 'PII' }] }),
  }).run();
  assert.deepEqual(pixel(result, 23, 17), BLACK);
  assert.deepEqual(pixel(result, 80, 18), BLACK); // Existing DOM/raster gate.
  assert.deepEqual(pixel(result, 56, 28), SOURCE);
  assert.doesNotMatch(JSON.stringify(result), /Alex|wordIndex|predictions|raw OCR/i);
});

for (const [name, model] of Object.entries({
  unknown: { detect: async () => ({}), review: () => ({ fullBlackout: true, regions: [] }) },
  thrown: { detect: async () => { throw new Error('private canary@example.test'); }, review: () => null },
  malformed: { detect: async () => ({}), review: () => ({ fullBlackout: false, regions: null }) },
})) test(`Phase 07 injected ${name} NER result forces full outgoing pixel blackout`, async () => {
  const result = await harness('public', { ready: true, ...model }).run();
  assert.deepEqual(pixel(result, 0, 0), BLACK);
  assert.deepEqual(pixel(result, WIDTH - 1, HEIGHT - 1), BLACK);
  assert.equal(result.result.visualPrivacy.pixelMaskCount, 1);
  assert.doesNotMatch(JSON.stringify(result), /private canary|Alex/i);
});

// Option B: separately licensed on-device model may ONLY add pixel masks.
// Genuine model execution is covered in phase-07-alternative-runtime.test.mjs;
// these fixtures specifically test the actual outbound worker/JPEG gates.
test('Phase 07 alternative adds an opaque outgoing pixel region without replacing OCR/DOM masks', async () => {
  const message = await harness('public', null, {
    ready: true,
    detect: async () => ({ fullBlackout: false, regions: [
      { x1: 13, y1: 12, x2: 43, y2: 22, kind: 'PII' }
    ] })
  }).run();
  assert.deepEqual(pixel(message, 23, 17), BLACK);
  assert.deepEqual(pixel(message, 80, 18), BLACK);
  assert.deepEqual(pixel(message, 56, 28), SOURCE);
  assert.doesNotMatch(JSON.stringify(message), /Alex|wordIndex|tokens|logits/i);
});

for (const [kind, alternative] of Object.entries({
  unknown: { ready: true, detect: async () => ({ fullBlackout: true, regions: [] }) },
  exception: { ready: true, detect: async () => { throw Error('secret synthetic canary@example.test'); } },
  malformed: { ready: true, detect: async () => ({ fullBlackout: false, regions: null }) }
})) test(`Phase 07 alternative ${kind} forces full outgoing pixel blackout`, async () => {
  const message = await harness('public', null, alternative).run();
  assert.deepEqual(pixel(message, 0, 0), BLACK);
  assert.deepEqual(pixel(message, WIDTH - 1, HEIGHT - 1), BLACK);
  assert.equal(message.result.visualPrivacy.pixelMaskCount, 1);
  assert.doesNotMatch(JSON.stringify(message), /Alex|canary@example|synthetic/i);
});

test('existing deterministic OCR coverage avoids redundant alternative model inference', async () => {
  const { runtime, requests } = alternativeContext();
  const message = await harness('pii', null, runtime).run();
  assert.deepEqual(pixel(message, 23, 17), BLACK); // Deterministic OCR email mask.
  assert.deepEqual(pixel(message, 80, 18), BLACK); // Existing DOM/raster mask.
  assert.deepEqual(pixel(message, 0, 0), SOURCE);
  assert.equal(message.result.visualPrivacy.pixelMaskCount, 2);
  assert.equal(message.result.visualPrivacy.coverageVerified, true);
  assert.equal(requests.length, 0);
  assert.doesNotMatch(JSON.stringify(message), /canary@example|model.quant|input_ids|logits|tokens/i);
});

test('genuine alternative ONNX/WASM public fixture preserves only permitted pixels', async () => {
  const { runtime } = alternativeContext();
  const message = await harness('greeting', null, runtime).run();
  assert.deepEqual(pixel(message, 80, 18), BLACK);
  assert.deepEqual(pixel(message, 56, 28), SOURCE);
  assert.equal(message.result.visualPrivacy.coverageVerified, true);
  assert.doesNotMatch(JSON.stringify(message), /Hello|world|logits|token/i);
});
