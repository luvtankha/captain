// Genuine offline inference through the exact extension adapter and pinned
// onnxruntime-web WASM. Only a generated, non-personal UI raster is used.
import { readFile, writeFile } from 'node:fs/promises';
import { createHash, webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { inflateSync } from 'node:zlib';
import ort from 'onnxruntime-web';

const here = new URL('../extension/controls/', import.meta.url);
const source = await readFile(new URL('ui-model.js', here), 'utf8');
const model = await readFile(new URL('model.onnx', here));
export const EXPECTED_SHA = 'd29b6210d171e3dc5454e09847aaabce6a0255eaefa565b639e1301a9e933ef9';
const W = 640, H = 640;
export const lease = Object.freeze({ documentToken: 'synthetic-document-01', observationId: 'synthetic-observation-01', domRevision: 1, geometryRevision: 1 });

export function syntheticRaster() {
  const pixels = new Uint8ClampedArray(W * H * 4);
  const rect = (x, y, w, h, rgb) => {
    for (let row = y; row < y + h; row++) for (let col = x; col < x + w; col++) {
      const i = (row * W + col) * 4;
      pixels.set([...rgb, 255], i);
    }
  };
  rect(0, 0, W, H, [237, 240, 244]);
  rect(0, 0, W, 52, [33, 44, 60]);
  rect(24, 85, 590, 482, [255, 255, 255]);
  rect(52, 142, 252, 46, [226, 231, 238]); // synthetic input field
  rect(52, 210, 252, 46, [226, 231, 238]); // synthetic private input
  rect(52, 281, 124, 43, [43, 105, 224]); // synthetic button
  rect(190, 281, 114, 43, [54, 170, 126]); // synthetic button
  rect(348, 142, 224, 183, [244, 246, 249]); // synthetic card
  rect(366, 178, 155, 8, [90, 103, 117]);
  rect(366, 196, 117, 8, [90, 103, 117]);
  return { width: W, height: H, pixels };
}

// Narrow PNG decoder for our pinned, disposable Chromium-generated RGB/RGBA
// fixture. No decoder package, remote conversion service or personal image.
export function decodePng(png) {
  if (!png.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) throw new Error('Invalid local PNG fixture.');
  let width = 0, height = 0, channels = 0; const compressed = [];
  for (let at = 8; at + 12 <= png.length;) {
    const length = png.readUInt32BE(at), type = png.toString('ascii', at + 4, at + 8);
    if (at + 12 + length > png.length) throw new Error('Invalid PNG length.');
    if (type === 'IHDR') {
      width = png.readUInt32BE(at + 8); height = png.readUInt32BE(at + 12);
      channels = png[at + 17] === 2 ? 3 : png[at + 17] === 6 ? 4 : 0;
      if (png[at + 16] !== 8 || !channels || png[at + 20] !== 0 ||
          width < 1 || height < 1 || width * height > 12_000_000) throw new Error('Unsupported PNG fixture.');
    } else if (type === 'IDAT') compressed.push(png.subarray(at + 8, at + 8 + length));
    else if (type === 'IEND') break;
    at += 12 + length;
  }
  if (!channels || !compressed.length) throw new Error('Missing PNG fixture pixels.');
  const stride = width * channels, raw = inflateSync(Buffer.concat(compressed), { maxOutputLength: (stride + 1) * height });
  if (raw.length !== (stride + 1) * height) throw new Error('Invalid PNG fixture rows.');
  const pixels = new Uint8ClampedArray(width * height * 4), previous = new Uint8Array(stride);
  for (let row = 0; row < height; row++) {
    const filter = raw[row * (stride + 1)], current = new Uint8Array(stride);
    if (filter > 4) throw new Error('Unsupported PNG filter.');
    for (let col = 0; col < stride; col++) {
      const x = raw[row * (stride + 1) + col + 1];
      const left = col >= channels ? current[col - channels] : 0;
      const up = previous[col], corner = col >= channels ? previous[col - channels] : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      if (filter === 2) predictor = up;
      if (filter === 3) predictor = Math.floor((left + up) / 2);
      if (filter === 4) {
        const estimate = left + up - corner;
        const dl = Math.abs(estimate - left), du = Math.abs(estimate - up), dc = Math.abs(estimate - corner);
        predictor = dl <= du && dl <= dc ? left : du <= dc ? up : corner;
      }
      current[col] = (x + predictor) & 255;
    }
    for (let col = 0; col < width; col++) {
      const src = col * channels, dest = (row * width + col) * 4;
      pixels[dest] = current[src]; pixels[dest + 1] = current[src + 1];
      pixels[dest + 2] = current[src + 2]; pixels[dest + 3] = channels === 4 ? current[src + 3] : 255;
    }
    previous.set(current);
  }
  return { width, height, pixels };
}

export class SyntheticCanvas {
  constructor(width, height) {
    this.width = width; this.height = height;
    this.pixels = new Uint8ClampedArray(width * height * 4);
    for (let i = 3; i < this.pixels.length; i += 4) this.pixels[i] = 255;
  }
  getContext() {
    const target = this;
    return {
      fillStyle: '#727272',
      fillRect(x, y, width, height) {
        const rgb = this.fillStyle === '#727272' ? [114, 114, 114] : [0, 0, 0];
        for (let row = y; row < y + height; row++) for (let col = x; col < x + width; col++)
          target.pixels.set([...rgb, 255], (row * target.width + col) * 4);
      },
      drawImage(bitmap, _sx, _sy, _sw, _sh, dx, dy, dw, dh) {
        for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) {
          // Approximate the default browser canvas bilinear resize instead of
          // the prior misleading nearest-neighbour test-only preprocessing.
          const fx = Math.max(0, Math.min(bitmap.width - 1, (x + 0.5) * bitmap.width / dw - 0.5));
          const fy = Math.max(0, Math.min(bitmap.height - 1, (y + 0.5) * bitmap.height / dh - 0.5));
          const x0 = Math.floor(fx), y0 = Math.floor(fy);
          const x1 = Math.min(bitmap.width - 1, x0 + 1), y1 = Math.min(bitmap.height - 1, y0 + 1);
          const wx = fx - x0, wy = fy - y0;
          const a = (y0 * bitmap.width + x0) * 4, b = (y0 * bitmap.width + x1) * 4;
          const c = (y1 * bitmap.width + x0) * 4, d = (y1 * bitmap.width + x1) * 4;
          const dest = ((dy + y) * target.width + dx + x) * 4;
          for (let channel = 0; channel < 4; channel++) {
            target.pixels[dest + channel] = (bitmap.pixels[a + channel] * (1 - wx) + bitmap.pixels[b + channel] * wx) * (1 - wy) +
              (bitmap.pixels[c + channel] * (1 - wx) + bitmap.pixels[d + channel] * wx) * wy;
          }
        }
      },
      getImageData() { return { data: target.pixels, width: target.width, height: target.height }; }
    };
  }
}

export function adapter({ bytes = model, missing = false, runtime = ort, researchConfidence = null } = {}) {
  if (researchConfidence !== null &&
      (![0.25,0.35,0.45,0.50,0.55,0.60,0.65,0.70,0.75].includes(researchConfidence)))
    throw new Error('Invalid research-only confidence threshold.');
  let actualRuns = 0;
  const wrappedORT = {
    Tensor: class { constructor(type, data, dims) {
      return new runtime.Tensor(type, Float32Array.from(data), Array.from(dims));
    } },
    InferenceSession: { create: async (...args) => {
      // Node's ORT API rejects a Uint8Array from the isolated vm realm.
      // Copy into host Buffer; real extension's ORT/adapter share one realm.
      const session = await runtime.InferenceSession.create(Buffer.from(args[0]), args[1]);
      return { inputNames: session.inputNames, outputNames: session.outputNames,
        run: async input => { actualRuns++; return session.run(input); } };
    } }
  };
  const context = { URL, ort: wrappedORT, crypto: webcrypto, OffscreenCanvas: SyntheticCanvas,
    self: { location: { href: 'chrome-extension://synthetic/vision-worker.js' } },
    fetch: async url => ({ ok: !missing && url === 'chrome-extension://synthetic/controls/model.onnx',
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }) };
  context.globalThis = context;
  // Research-only sandbox source substitution; deployed extension files,
  // pinned weights, original production confidence and fusion stay unchanged.
  const researchSource = researchConfidence === null ? source :
    source.replace('const CONFIDENCE = 0.75, IOU',
      `const CONFIDENCE = ${researchConfidence.toFixed(2)}, IOU`);
  const debugSource = process.env.CAPTAIN_SYNTHETIC_DEBUG === '1' ?
    researchSource.replaceAll('catch { throw new Error(ERROR); }', 'catch (error) { root.__debug?.(String(error)); throw new Error(ERROR); }') : researchSource;
  context.__debug = value => console.error('Synthetic harness adapter error:', value);
  runInNewContext(debugSource, context);
  return { detector: context.CaptainUIModel, runs: () => actualRuns };
}

const p = (percentile, values) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * percentile / 100) - 1];
export async function benchmark(iterations = 5, screenshot = syntheticRaster(), sourceLabel = 'generated 640x640 non-personal UI raster') {
  if (createHash('sha256').update(model).digest('hex') !== EXPECTED_SHA) throw new Error('Unverified checkpoint.');
  ort.env.wasm.numThreads = 1; ort.env.wasm.simd = true;
  const { detector, runs } = adapter();
  const warmup = performance.now();
  const first = await detector.detect(screenshot, screenshot.width, screenshot.height, lease);
  const firstMs = performance.now() - warmup;
  const times = [], memory = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    const result = await detector.detect(screenshot, screenshot.width, screenshot.height, lease);
    times.push(performance.now() - start);
    memory.push(process.memoryUsage().rss);
    if (JSON.stringify(result.detections) !== JSON.stringify(first.detections)) throw new Error('Unstable real inference.');
  }
  return {
    task: 'real-on-device-ui-model-inference', input: sourceLabel,
    backend: 'onnxruntime-web WASM / CPU single thread', quantization: 'upstream FP32 ONNX; none',
    sha256: EXPECTED_SHA, bytes: model.length, iterations, actualModelRuns: runs(),
    firstRunMs: Math.round(firstMs), p50Ms: Math.round(p(50, times)), p95Ms: Math.round(p(95, times)),
    peakRssMiB: Math.round(Math.max(...memory) / 1048576), detections: first.detections.length,
    boxes: first.detections.map(item => item.box),
    scope: 'Windows Node-hosted extension adapter; synthetic raster, not a browser/CSP or real-world accuracy measurement'
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url).toLowerCase() === process.argv[1].toLowerCase()) {
  const browser = process.argv.includes('--browser-fixture');
  const screenshot = browser ? decodePng(await readFile(new URL('../benchmarks/phase-06-isolated-ui.png', import.meta.url))) : syntheticRaster();
  const result = await benchmark(Number(process.argv[2] || 5), screenshot, browser ? 'isolated Edge file:/// synthetic form PNG' : 'generated 640x640 non-personal UI raster');
  await writeFile(new URL(browser ? '../benchmarks/phase-06-real-browser-fixture.json' : '../benchmarks/phase-06-real-inference.json', import.meta.url), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
}
