// Classic-script API imported by extension/vision-worker.js. Only this trusted
// extension worker sees raw OCR strings. Never post this result to the device,
// planner, state, logs, error channels, or the page.
importScripts('text/vendor/tesseract.min.js');

(() => {
  'use strict';
  const BASE = new URL('text/', self.location.href);
  const ERROR = 'Local OCR unavailable.';
  const MAX_PIXELS = 8_000_000;
  const MAX_WORDS = 600;
  const HASHES = Object.freeze({
    'vendor/tesseract.min.js': ['10fff78484067759c43028a02a72d76d0b90eb17302bb23b58a9ec5410bc928b', 62961],
    'vendor/worker.min.js': ['38645599043239c0eb6db08a6504a92dcdc292200535f3e9339cd77c4443b842', 111162],
    'vendor/tesseract-core-lstm.wasm.js': ['775a35df6f2ae100e02609443e6bd5cafcd07983dd6175454ca4a432a7730687', 3954181],
    'vendor/tesseract-core-lstm.wasm': ['220e2e87551edccb85519796a170469f8ab2a8055216789e3b8b1ada18b7bc2b', 2871085],
    'vendor/tesseract-core-simd-lstm.wasm.js': ['9d7c43fb206dc9f48475228b46bf35f888fa9e6259da2e67d5a75c77049f2dc7', 3954569],
    'vendor/tesseract-core-simd-lstm.wasm': ['187d76742dfc0d8929f0b49a619f145bb6370730776c7bd0d3e20c6b2098808d', 2871377],
    'languages/eng.traineddata.gz': ['45b4cb346724ac1774f1c36f42f182b887bcdb28ebe63e6fff90ac41f3fcff91', 2952873]
  });
  let disabled = false;
  let checkedAssets;

  function localURL(path) {
    const url = new URL(path, BASE);
    if (!['chrome-extension:', 'moz-extension:'].includes(url.protocol) ||
        url.protocol !== BASE.protocol || url.host !== BASE.host ||
        !url.pathname.startsWith(BASE.pathname) || url.search || url.hash) throw new Error(ERROR);
    return url.href;
  }
  async function sha256(bytes) {
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  }
  async function verifyAssets() {
    if (disabled) throw new Error(ERROR);
    if (!checkedAssets) {
      checkedAssets = (async () => {
        if (typeof self.Worker !== 'function' || typeof self.OffscreenCanvas !== 'function' ||
            !self.Tesseract?.createWorker || !crypto?.subtle) throw new Error(ERROR);
        for (const [name, [hash, length]] of Object.entries(HASHES)) {
          const url = localURL(name);
          const response = await fetch(url, { cache: 'no-store' });
          if (!response.ok || (response.url && response.url !== url)) throw new Error(ERROR);
          const bytes = await response.arrayBuffer();
          if (bytes.byteLength !== length || await sha256(bytes) !== hash) throw new Error(ERROR);
        }
      })();
    }
    try { await checkedAssets; }
    catch { disabled = true; throw new Error(ERROR); }
  }
  function timed(promise, milliseconds, onLate) {
    let timeoutId;
    let expired = false;
    const work = Promise.resolve(promise).then(value => {
      if (expired && onLate) { try { onLate(value); } catch {} }
      return value;
    });
    const timeout = new Promise((_, reject) => {
      timeoutId = setTimeout(() => { expired = true; reject(new Error(ERROR)); }, milliseconds);
    });
    return Promise.race([work, timeout]).finally(() => clearTimeout(timeoutId));
  }
  function validNumber(number) { return typeof number === 'number' && Number.isFinite(number); }
  function extractWords(data, width, height) {
    const blocks = data?.blocks;
    if (!Array.isArray(blocks) || !blocks.length || blocks.length > 100) throw new Error(ERROR);
    const words = [];
    for (const block of blocks) {
      if (!Array.isArray(block?.paragraphs)) throw new Error(ERROR);
      for (const paragraph of block.paragraphs) {
        if (!Array.isArray(paragraph?.lines)) throw new Error(ERROR);
        for (const line of paragraph.lines) {
          if (!Array.isArray(line?.words)) throw new Error(ERROR);
          for (const word of line.words) {
            const text = word?.text;
            const confidence = word?.confidence;
            const { x0, y0, x1, y1 } = word?.bbox || {};
            if (typeof text !== 'string' || !text.trim() || text.length > 128 ||
                !validNumber(confidence) || confidence < 0 || confidence > 100 ||
                ![x0, y0, x1, y1].every(validNumber) ||
                x0 < 0 || y0 < 0 || x1 > width || y1 > height || x1 <= x0 || y1 <= y0) {
              throw new Error(ERROR);
            }
            // Text stays inside this worker. OCR geometry will semantically
            // scan only reliable ASCII rows and mask the full row for every
            // other script/uncertain token, rather than discarding the whole
            // screenshot because the installed English OCR read such a token.
            words.push({ text, confidence, bbox: { x0, y0, x1, y1 } });
            if (words.length > MAX_WORDS) throw new Error(ERROR);
          }
        }
      }
    }
    // Empty OCR is ambiguous: blank image versus missed raster text.
    if (!words.length) throw new Error(ERROR);
    return words;
  }
  async function recognize(bitmap, width, height) {
    let worker;
    try {
      if (disabled || !Number.isSafeInteger(width) || !Number.isSafeInteger(height) ||
          width < 1 || height < 1 || width * height > MAX_PIXELS ||
          bitmap?.width !== width || bitmap?.height !== height) throw new Error(ERROR);
      await timed(verifyAssets(), 20_000);
      const canvas = new OffscreenCanvas(width, height);
      const context = canvas.getContext('2d', { alpha: false });
      if (!context) throw new Error(ERROR);
      context.drawImage(bitmap, 0, 0);
      const blob = await timed(canvas.convertToBlob({ type: 'image/png' }), 12_000);
      if (blob?.type !== 'image/png' || blob.size < 20 || blob.size > 24_000_000) throw new Error(ERROR);
      const bytes = new Uint8Array(await timed(blob.arrayBuffer(), 12_000));
      worker = await timed(self.Tesseract.createWorker('eng', 1, {
        workerPath: localURL('worker-bootstrap.js'),
        corePath: localURL('vendor/').replace(/\/$/, ''),
        langPath: localURL('languages/').replace(/\/$/, ''),
        workerBlobURL: false,
        cacheMethod: 'none',
        gzip: true,
        legacyCore: false,
        legacyLang: false,
        logger: () => {},
        errorHandler: () => {}
      }), 35_000, lateWorker => { lateWorker?.terminate?.(); });
      const result = await timed(worker.recognize(bytes, {}, { text: false, blocks: true }), 25_000);
      return { words: extractWords(result?.data, width, height), complete: true, language: 'eng' };
    } catch {
      disabled = true;
      throw new Error(ERROR);
    } finally {
      // A nested Tesseract worker may stop answering after a recognition
      // timeout. Its asynchronous terminate() must not indefinitely hold the
      // enclosing visual worker (and its raw screenshot). If teardown stalls,
      // the outer vision worker is still terminated by the trusted controller
      // and the screenshot is withheld. Never treat this as successful OCR.
      if (worker) { try { await timed(worker.terminate(), 2000); } catch { disabled = true; } }
    }
  }
  self.CaptainLocalOCR = Object.freeze({
    language: 'eng',
    get ready() { return !disabled && BASE.protocol !== 'http:' && BASE.protocol !== 'https:'; },
    recognize
  });
})();
