import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { createHash, webcrypto } from 'node:crypto';

const coreSource = await readFile(new URL('../extension/vision-core.js', import.meta.url), 'utf8');
const workerSource = await readFile(new URL('../extension/vision-worker.js', import.meta.url), 'utf8');
const modelHash = 'd7c687949526065ab6a192fdf993360045ce27b0fabf7c9fca5c2437b786b495';
const WIDTH = 80, HEIGHT = 64;
const BLACK = [9, 9, 11];
const rawPixel = [213, 47, 63]; // synthetic canary pixels only

function fixture(options = {}) {
  const messages = [];
  const sourcePixels = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
  for (let i = 0; i < sourcePixels.length; i += 4) sourcePixels.set([...rawPixel, 255], i);
  const source = { width: options.width ?? WIDTH, height: options.height ?? HEIGHT, pixels: sourcePixels };

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
          const pixels = image.pixels;
          if (!pixels) throw new Error('Missing synthetic source pixels.');
          for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
            const srcX = Math.min(image.width - 1, Math.floor(x * image.width / canvas.width));
            const srcY = Math.min(image.height - 1, Math.floor(y * image.height / canvas.height));
            const from = (srcY * image.width + srcX) * 4, to = (y * canvas.width + x) * 4;
            canvas.pixels.set(pixels.subarray(from, from + 4), to);
          }
        },
        fillRect(x, y, width, height) {
          if (this.fillStyle !== '#09090b') throw new Error('Non-opaque synthetic mask.');
          for (let row = y; row < y + height; row++) for (let col = x; col < x + width; col++) {
            const at = (row * canvas.width + col) * 4;
            canvas.pixels.set([...BLACK, 255], at);
          }
        },
        getImageData(x, y, width, height) {
          const pixels = new Uint8ClampedArray(width * height * 4);
          for (let row = 0; row < height; row++) for (let col = 0; col < width; col++) {
            const from = ((y + row) * canvas.width + x + col) * 4;
            const to = (row * width + col) * 4;
            pixels.set(canvas.pixels.subarray(from, from + 4), to);
          }
          if (options.corruptReadback && canvas.width === source.width && canvas.height === source.height) pixels[0] = 250;
          return { width, height, data: pixels };
        }
      };
    }
    async convertToBlob() {
      if (options.badOutput === 'throw') throw new Error('synthetic raw secret in codec error');
      const bytes = new Uint8Array(3 + this.width * this.height * 3 + 2);
      bytes.set([255, 216, 255]);
      const decoded = new Uint8ClampedArray(this.pixels);
      for (let i = 0, at = 3; i < decoded.length; i += 4, at += 3) {
        if (options.badOutput === 'unmasked') decoded.set([...rawPixel, 255], i);
        bytes.set(decoded.subarray(i, i + 3), at);
      }
      bytes.set([255, 217], bytes.length - 2);
      if (options.badOutput === 'marker') bytes[0] = 0;
      const bytesOut = options.badOutput === 'oversize' ? new Uint8Array(2_500_001) : bytes;
      return {
        type: 'image/jpeg', size: bytesOut.length, arrayBuffer: async () => bytesOut.buffer.slice(0),
        width: this.width, height: this.height, pixels: decoded
      };
    }
  }

  const session = {
    inputNames: ['input'],
    run: async () => {
      if (options.modelRunHangs) return new Promise(() => {});
      if (options.modelRunError) throw new Error('synthetic raw secret from model');
      if (options.tensors) return options.tensors;
      return {
        scores: { type: 'float32', dims: [1, 1, 2], data: new Float32Array([0.02, 0.98]) },
        boxes: { type: 'float32', dims: [1, 1, 4], data: new Float32Array([0.26, 0.25, 0.45, 0.45]) }
      };
    }
  };
  const subtle = {
    digest: async (algorithm, bytes) => {
      if (bytes.byteLength === 100_001) return Uint8Array.from(Buffer.from(options.badModelHash ? 'a'.repeat(64) : modelHash, 'hex')).buffer;
      return webcrypto.subtle.digest(algorithm, bytes);
    }
  };
  const sandbox = {
    URL, Float32Array, Uint8Array, Uint8ClampedArray, ArrayBuffer, Math, Number,
    setTimeout: (fn, ms) => setTimeout(fn, options.fastTimeout && ms === 30000 ? 0 : ms), clearTimeout,
    performance: { now: () => 10 }, crypto: { subtle }, OffscreenCanvas: Canvas,
    btoa: value => Buffer.from(value, 'binary').toString('base64'),
    fetch: async value => String(value).endsWith('.onnx') ? {
      ok: !options.modelFetchError,
      arrayBuffer: async () => new ArrayBuffer(100_001)
    } : { ok: true, blob: async () => ({ type: 'image/jpeg', size: 200 }) },
    createImageBitmap: async blob => blob.pixels ? { width: blob.width, height: blob.height, pixels: blob.pixels, close() {} } : source,
    ort: {
      env: { wasm: {} }, Tensor: class { constructor(type, data, dims) { Object.assign(this, { type, data, dims }); } },
      InferenceSession: { create: async () => options.modelLoadHangs ? new Promise(() => {}) : session }
    },
    // Legacy Phase-04 pixel fixtures isolate face/DOM/JPEG behavior; actual
    // Phase-05 OCR and OCR-failure behavior have separate dedicated tests.
    CaptainLocalOCR: { ready: true, recognize: async () => ({ complete: true, words: [] }) },
    CaptainOCRGeometry: { review: () => ({ fullBlackout: false, regions: [] }) },
    CAPTAIN_PRIVACY: { scanSpans: () => [] },
    self: { location: { href: 'chrome-extension://synthetic/vision-worker.js' }, postMessage: message => messages.push(message) },
    importScripts: () => {}
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(coreSource, sandbox);
  vm.runInContext(workerSource, sandbox);
  async function run(request = {}) {
    await sandbox.self.onmessage({ data: {
      id: 12,
      screenshot: 'data:image/jpeg;base64,' + Buffer.alloc(120, 42).toString('base64'),
      viewport: { width: WIDTH, height: HEIGHT, devicePixelRatio: 1 },
      redactionBoxes: [], ...request
    } });
    return messages.at(-1);
  }
  return { run, source, messages, core: sandbox.CaptainVisionCore };
}

function outputPixels(message) {
  assert.equal(message.ok, true, message.error);
  const bytes = Buffer.from(message.result.screenshot.split(',')[1], 'base64');
  assert.deepEqual([...bytes.subarray(0, 3)], [255, 216, 255]);
  assert.deepEqual([...bytes.subarray(-2)], [255, 217]);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), message.result.visualPrivacy.imageSha256);
  assert.equal(bytes.length, message.result.visualPrivacy.outputBytes);
  return (x, y) => [...bytes.subarray(3 + (y * WIDTH + x) * 3, 3 + (y * WIDTH + x) * 3 + 3)];
}

test('verified viewport dimensions and box geometry reject nonfinite or inconsistent mappings', () => {
  const { core } = fixture();
  assert.equal(core.verifyCaptureGeometry({ width: 40, height: 32, devicePixelRatio: 2 }, WIDTH, HEIGHT).safe, true);
  assert.equal(core.verifyCaptureGeometry({ width: 40, height: 20, devicePixelRatio: 2 }, WIDTH, HEIGHT).safe, false);
  assert.equal(core.verifyCaptureGeometry({ width: WIDTH, height: HEIGHT, devicePixelRatio: Infinity }, WIDTH, HEIGHT).safe, false);
  assert.throws(() => core.verifyCaptureGeometry({ width: WIDTH, height: HEIGHT, devicePixelRatio: 1 }, Infinity, HEIGHT));
  assert.throws(() => core.mapDomBox({ x: NaN, y: 1, width: 2, height: 3, kind: 'PII' }, 1, 1, WIDTH, HEIGHT));
  assert.throws(() => core.mapDomBox({ x: 1, y: 1, width: 2, height: 3, kind: 'UNREVIEWED' }, 1, 1, WIDTH, HEIGHT));
});

test('raster, background and nested privacy geometry become opaque pixels with matching native v2 digest', async () => {
  const message = await fixture().run({ redactionBoxes: [
    { x: 5, y: 49, width: 14, height: 10, kind: 'EMAIL' },
    { x: 53, y: 10, width: 15, height: 20, kind: 'RASTER_CONTENT' },
    { x: 60, y: 45, width: 10, height: 10, kind: 'BACKGROUND_IMAGE' }
  ] });
  const pixel = outputPixels(message), proof = message.result.visualPrivacy;
  assert.equal(proof.schema, 'captain.visual-privacy.v2');
  assert.equal(proof.maskPolicy, 'opaque-raster-v1');
  assert.equal(proof.coverageVerified, true);
  assert.equal(proof.backend, 'wasm');
  assert.equal(proof.modelSha256, modelHash);
  assert.equal(proof.pixelMaskCount, 4);
  assert.equal(proof.fullBlackout, false);
  assert.equal(proof.domBoxes, 3);
  assert.equal(proof.faces, 1);
  assert.deepEqual(pixel(12, 53), BLACK);
  assert.deepEqual(pixel(58, 17), BLACK);
  assert.deepEqual(pixel(66, 50), BLACK);
  assert.deepEqual(pixel(28, 23), BLACK); // detected face is solid-black, never pixelated
  assert.deepEqual(pixel(79, 63), rawPixel);
});

test('unknown, omitted or invalid region geometry blacks out the entire source image', async () => {
  const requests = [
    { redactionBoxes: [{ x: 0, y: 0, width: 2, height: 2, kind: 'UNKNOWN' }] },
    { redactionBoxes: undefined },
    { redactionBoxes: [{ x: Infinity, y: 5, width: 5, height: 5, kind: 'PII' }] },
    { redactionBoxes: [{ x: 5, y: 5, width: 5, height: 5, kind: 'UNREVIEWED' }] },
    { viewport: { width: WIDTH, height: 30, devicePixelRatio: 1 } },
    { viewport: { width: WIDTH, height: HEIGHT, devicePixelRatio: 2 } }
  ];
  for (const request of requests) {
    const message = await fixture().run(request);
    const pixel = outputPixels(message);
    assert.equal(message.result.visualPrivacy.pixelMaskCount, 1);
    assert.equal(message.result.visualPrivacy.fullBlackout, true);
    assert.deepEqual(pixel(0, 0), BLACK);
    assert.deepEqual(pixel(79, 63), BLACK);
  }
});

test('no detected face and no safe region triggers a full-frame opaque mask', async () => {
  const message = await fixture({ tensors: {
    scores: { type: 'float32', dims: [1, 1, 2], data: new Float32Array([0.99, 0.01]) },
    boxes: { type: 'float32', dims: [1, 1, 4], data: new Float32Array([0.1, 0.1, 0.3, 0.3]) }
  } }).run();
  assert.equal(message.result.visualPrivacy.faces, 0);
  assert.equal(message.result.visualPrivacy.pixelMaskCount, 1);
  assert.deepEqual(outputPixels(message)(79, 63), BLACK);
});

test('detector tensor shape mismatch and nonfinite/invalid coordinates withhold every image', async () => {
  const samples = [
    { scores: { type: 'float32', dims: [1, 2, 2], data: new Float32Array([0, 1, 0, 1]) }, boxes: { type: 'float32', dims: [1, 1, 4], data: new Float32Array([0.1, 0.1, 0.3, 0.3]) } },
    { scores: { type: 'float32', dims: [1, 1, 2], data: new Float32Array([0, NaN]) }, boxes: { type: 'float32', dims: [1, 1, 4], data: new Float32Array([0.1, 0.1, 0.3, 0.3]) } },
    { scores: { type: 'float32', dims: [1, 1, 2], data: new Float32Array([0, 0.99]) }, boxes: { type: 'float32', dims: [1, 1, 4], data: new Float32Array([0.6, 0.1, 0.3, 0.3]) } },
    { scores: { type: 'float32', dims: [1, 1, 2], data: new Float32Array([0, 0.99]) }, boxes: { type: 'float32', dims: [1, 1, 4], data: new Float32Array([Infinity, 0.1, 0.3, 0.3]) } }
  ];
  for (const tensors of samples) {
    const message = await fixture({ tensors }).run();
    assert.deepEqual(JSON.parse(JSON.stringify(message)), { id: 12, ok: false, error: 'Local visual privacy failed.' });
  }
});

test('model load, pinned digest and inference failures return generic error with no screenshot or raw exception', async () => {
  for (const options of [{ badModelHash: true }, { modelFetchError: true }, { modelRunError: true }]) {
    const message = await fixture(options).run();
    assert.deepEqual(JSON.parse(JSON.stringify(message)), { id: 12, ok: false, error: 'Local visual privacy failed.' });
  }
});

test('hung face-model loading or inference fails closed on the bounded model watchdog', async () => {
  for (const options of [{ modelLoadHangs: true }, { modelRunHangs: true }]) {
    const message = await fixture({ ...options, fastTimeout: true }).run();
    assert.deepEqual(JSON.parse(JSON.stringify(message)), { id: 12, ok: false, error: 'Local visual privacy failed.' });
  }
});

test('pixel readback and JPEG encoder failures block output before proof is marked verified', async () => {
  for (const options of [{ corruptReadback: true }, { badOutput: 'throw' }, { badOutput: 'marker' }, { badOutput: 'oversize' }, { badOutput: 'unmasked' }]) {
    const message = await fixture(options).run({ redactionBoxes: [{ x: 0, y: 0, width: WIDTH, height: HEIGHT, kind: 'PII' }] });
    assert.equal(message.ok, false);
    assert.equal(message.error, 'Local visual privacy failed.');
    assert.equal(message.result, undefined);
  }
});

test('invalid image input blocks before raw data is sent or reflected in error', async () => {
  const message = await fixture().run({ screenshot: 'data:image/png;base64,SECRET-CANARY' });
  assert.deepEqual(JSON.parse(JSON.stringify(message)), { id: 12, ok: false, error: 'Local visual privacy failed.' });
});
