import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { readFile, readFileSync } from 'node:fs';
import { readFile as readFileAsync } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { deflateSync } from 'node:zlib';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const ocrDir = join(root, 'extension', 'text');
const assets = {
  'vendor/tesseract.min.js': ['10fff78484067759c43028a02a72d76d0b90eb17302bb23b58a9ec5410bc928b', 62961],
  'vendor/worker.min.js': ['38645599043239c0eb6db08a6504a92dcdc292200535f3e9339cd77c4443b842', 111162],
  'vendor/tesseract-core-lstm.wasm.js': ['775a35df6f2ae100e02609443e6bd5cafcd07983dd6175454ca4a432a7730687', 3954181],
  'vendor/tesseract-core-lstm.wasm': ['220e2e87551edccb85519796a170469f8ab2a8055216789e3b8b1ada18b7bc2b', 2871085],
  'vendor/tesseract-core-simd-lstm.wasm.js': ['9d7c43fb206dc9f48475228b46bf35f888fa9e6259da2e67d5a75c77049f2dc7', 3954569],
  'vendor/tesseract-core-simd-lstm.wasm': ['187d76742dfc0d8929f0b49a619f145bb6370730776c7bd0d3e20c6b2098808d', 2871377],
  'languages/eng.traineddata.gz': ['45b4cb346724ac1774f1c36f42f182b887bcdb28ebe63e6fff90ac41f3fcff91', 2952873]
};
const source = path => readFileSync(join(ocrDir, path), 'utf8');

test('installed runtime/core/English traineddata match pinned bytes, package metadata and notices', async () => {
  for (const [name, [hash, length]] of Object.entries(assets)) {
    const bytes = await readFileAsync(join(ocrDir, name));
    assert.equal(bytes.length, length, name);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), hash, name);
  }
  const pkg = JSON.parse(await readFileAsync(join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(await readFileAsync(join(root, 'package-lock.json'), 'utf8'));
  for (const [name, version] of [['tesseract.js', '6.0.1'], ['tesseract.js-core', '6.0.0'], ['@tesseract.js-data/eng', '1.0.0']]) {
    assert.equal(pkg.dependencies[name], version);
    assert.equal(lock.packages[`node_modules/${name}`].version, version);
    assert.match(lock.packages[`node_modules/${name}`].integrity, /^sha512-/);
  }
  assert.match(source('vendor/TESSERACTJS-LICENSE.txt'), /Apache License/);
  assert.match(source('vendor/TESSERACTCORE-LICENSE.txt'), /Apache License/);
  assert.match(source('LANGUAGE-DATA-MIT-LICENSE.txt'), /MIT License/);
  assert.match(source('NOTICE.txt'), /English\/Latin/);
});

test('build/package must verify every local OCR asset and license before copying the extension', async () => {
  const packager = await readFileAsync(join(root, 'tools', 'package.mjs'), 'utf8');
  for (const [name, [, length,]] of Object.entries(assets)) {
    assert.ok(packager.includes(name), `missing package check for ${name}`);
    assert.ok(packager.includes(String(length)), `missing length for ${name}`);
  }
  assert.match(packager, /Bundled local OCR asset integrity failed/);
  assert.match(packager, /LANGUAGE-DATA-MIT-LICENSE/);
  assert.match(packager, /workerBlobURL: false/);
  assert.match(source('ocr-runtime.js'), /cacheMethod: 'none'/);
  assert.match(source('ocr-runtime.js'), /workerPath: localURL\('worker-bootstrap.js'\)/);
  assert.doesNotMatch(source('ocr-runtime.js'), /https?:\/\/[^\s]+(?:cdn|tessdata)/);
});

function fixture({ modelTamper = false, recognizeResult, recognitionError = null } = {}) {
  const traffic = [];
  let opened;
  let terminated = 0;
  let createCalls = 0;
  class Canvas {
    getContext() { return { drawImage() {} }; }
    async convertToBlob() {
      return { type: 'image/png', size: 100, async arrayBuffer() { return new Uint8Array(100).buffer; } };
    }
  }
  const reply = recognizeResult ?? { data: { blocks: [{ paragraphs: [{ lines: [{ words: [
    { text: 'CAPTAIN', confidence: 91, bbox: { x0: 1, y0: 2, x1: 75, y1: 22 } }
  ] }] }] }] } };
  const tesseract = {
    async createWorker(language, oem, options) {
      createCalls++;
      opened = { language, oem, options };
      return {
        async recognize() {
          if (recognitionError) throw recognitionError;
          return reply;
        },
        async terminate() { terminated++; }
      };
    }
  };
  const self = {
    location: { href: 'chrome-extension://synthetic-captain/vision-worker.js' },
    Worker: class {},
    OffscreenCanvas: Canvas,
    Tesseract: tesseract
  };
  const fetch = async url => {
    traffic.push(String(url));
    const parsed = new URL(url);
    if (parsed.protocol !== 'chrome-extension:' || parsed.host !== 'synthetic-captain') {
      throw new Error('Attempted remote request');
    }
    const file = parsed.pathname.replace(/^\/text\//, '');
    let bytes = readFileSync(join(ocrDir, file));
    if (modelTamper && file === 'languages/eng.traineddata.gz') bytes = Buffer.from(bytes.subarray(0, bytes.length - 1));
    return { ok: true, url: String(url), async arrayBuffer() { return bytes; } };
  };
  const context = { self, fetch, importScripts() {}, crypto: webcrypto, setTimeout, clearTimeout, OffscreenCanvas: Canvas, URL };
  runInNewContext(source('ocr-runtime.js'), context, { timeout: 3000 });
  return { api: self.CaptainLocalOCR, traffic, get opened() { return opened; }, get terminated() { return terminated; }, get createCalls() { return createCalls; } };
}

test('real asset hashes are checked before local OCR; worker receives explicit extension URLs and no logging', async () => {
  const f = fixture();
  const result = await f.api.recognize({ width: 200, height: 100 }, 200, 100);
  assert.equal(result.complete, true);
  assert.equal(result.language, 'eng');
  assert.equal(result.words.length, 1);
  assert.equal(result.words[0].text, 'CAPTAIN');
  assert.equal(f.createCalls, 1);
  assert.equal(f.terminated, 1);
  assert.equal(f.opened.language, 'eng');
  assert.equal(f.opened.oem, 1);
  assert.equal(f.opened.options.workerBlobURL, false);
  assert.equal(f.opened.options.cacheMethod, 'none');
  for (const key of ['workerPath', 'corePath', 'langPath']) {
    assert.match(f.opened.options[key], /^chrome-extension:\/\/synthetic-captain\/text\//);
  }
  assert.equal(f.traffic.length, 7);
  assert.ok(f.traffic.every(url => url.startsWith('chrome-extension://synthetic-captain/text/')));
});

test('tampered traineddata disables OCR before starting inference', async () => {
  const f = fixture({ modelTamper: true });
  await assert.rejects(f.api.recognize({ width: 200, height: 100 }, 200, 100), /^Error: Local OCR unavailable\.$/);
  assert.equal(f.api.ready, false);
  assert.equal(f.createCalls, 0);
});

test('malformed OCR box and raw model error fail closed with generic error only', async () => {
  const badBox = fixture({ recognizeResult: { data: { blocks: [{ paragraphs: [{ lines: [{ words: [
    { text: 'secret', confidence: 90, bbox: { x0: -2, y0: 0, x1: 80, y1: 20 } }
  ] }] }] }] } } });
  await assert.rejects(badBox.api.recognize({ width: 200, height: 100 }, 200, 100), /^Error: Local OCR unavailable\.$/);
  assert.equal(badBox.api.ready, false);
  const poisoned = fixture({ recognitionError: new Error('synthetic-canary@example.invalid') });
  await assert.rejects(poisoned.api.recognize({ width: 200, height: 100 }, 200, 100), /^Error: Local OCR unavailable\.$/);
  assert.equal(poisoned.terminated, 1);
  const empty = fixture({ recognizeResult: { data: { blocks: [] } } });
  await assert.rejects(empty.api.recognize({ width: 200, height: 100 }, 200, 100), /^Error: Local OCR unavailable\.$/);
});

test('nested OCR worker blocks remote fetch, XHR, and importScripts before dispatch', () => {
  const imported = [];
  const fetched = [];
  class XHR {
    open(method, url) { fetched.push(`${method} ${url}`); }
  }
  const self = {
    location: { href: 'moz-extension://synthetic/text/worker-bootstrap.js' },
    console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
    XMLHttpRequest: XHR,
    importScripts(...paths) { imported.push(...paths); },
    fetch(url) { fetched.push(url); return Promise.resolve({ ok: true }); }
  };
  runInNewContext(source('worker-bootstrap.js'), { self, URL }, { timeout: 3000 });
  assert.deepEqual(imported, ['moz-extension://synthetic/text/vendor/worker.min.js']);
  assert.throws(() => self.importScripts('https://cdn.example.invalid/worker.js'), /Local OCR unavailable/);
  assert.throws(() => self.fetch('https://cdn.example.invalid/eng.traineddata.gz'), /Local OCR unavailable/);
  assert.throws(() => new self.XMLHttpRequest().open('POST', 'moz-extension://synthetic/text/languages/eng.traineddata.gz'), /Local OCR unavailable/);
  assert.throws(() => new self.XMLHttpRequest().open('GET', 'https://remote.invalid/model'), /Local OCR unavailable/);
  self.fetch('moz-extension://synthetic/text/languages/eng.traineddata.gz');
  assert.equal(fetched.length, 1);
});

// Optional genuine Node/WASM/model inference with a locally generated synthetic
// bitmap. Enable manually with CAPTAIN_OCR_REAL_MODEL=1; it is intentionally
// excluded from the ordinary static suite to avoid claiming browser validation.
if (process.env.CAPTAIN_OCR_REAL_MODEL === '1') {
  function pngChunk(type, data) {
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const typeBytes = Buffer.from(type);
    const payload = Buffer.concat([typeBytes, data]);
    let crc = 0xffffffff;
    for (const byte of payload) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    const checksum = Buffer.alloc(4); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, payload, checksum]);
  }
  function syntheticPng() {
    const glyphs = {
      C: ['01110','10001','10000','10000','10000','10001','01110'],
      A: ['01110','10001','10001','11111','10001','10001','10001'],
      P: ['11110','10001','10001','11110','10000','10000','10000'],
      T: ['11111','00100','00100','00100','00100','00100','00100'],
      I: ['11111','00100','00100','00100','00100','00100','11111'],
      N: ['10001','11001','10101','10011','10001','10001','10001']
    };
    const width = 330, height = 78, scale = 7;
    const rowSize = 1 + width * 3;
    const pixels = Buffer.alloc(rowSize * height, 255);
    for (let row = 0; row < height; row++) pixels[row * rowSize] = 0;
    'CAPTAIN'.split('').forEach((letter, index) => {
      glyphs[letter].forEach((bits, y) => {
        [...bits].forEach((bit, x) => {
          if (bit === '0') return;
          for (let sy = 0; sy < scale; sy++) for (let sx = 0; sx < scale; sx++) {
            const pos = ((14 + y * scale + sy) * rowSize) + 1 + (10 + index * 42 + x * scale + sx) * 3;
            pixels.fill(0, pos, pos + 3);
          }
        });
      });
    });
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8; ihdr[9] = 2;
    return Buffer.concat([
      Buffer.from('89504e470d0a1a0a', 'hex'),
      pngChunk('IHDR', ihdr), pngChunk('IDAT', deflateSync(pixels)), pngChunk('IEND', Buffer.alloc(0))
    ]);
  }
  test('actual installed Tesseract Node WASM detects synthetic local pixel text', { timeout: 120_000 }, async () => {
    const { createWorker } = await import('tesseract.js');
    const worker = await createWorker('eng', 1, {
      langPath: join(ocrDir, 'lang'),
      gzip: true,
      cacheMethod: 'none',
      logger: () => {},
      errorHandler: () => {}
    });
    try {
      const data = (await worker.recognize(syntheticPng(), {}, { text: true, blocks: true })).data;
      assert.ok(Array.isArray(data.blocks));
      assert.ok(data.blocks.some(block => block.paragraphs?.some(p => p.lines?.some(line => line.words?.length))));
      assert.match(data.text, /[A-Z]{3}/);
    } finally { await worker.terminate(); }
  });
}
