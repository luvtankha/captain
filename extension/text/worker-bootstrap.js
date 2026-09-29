// Runs only in a dedicated extension-owned nested OCR worker. Third-party
// Tesseract scripts may load exactly the declared local core and language files.
// Any other request is denied before it can reach the browser's network stack.
(() => {
  'use strict';
  const base = new URL('./', self.location.href);
  if (!['chrome-extension:', 'moz-extension:'].includes(base.protocol)) {
    throw new Error('Local OCR unavailable.');
  }
  const names = [
    'vendor/worker.min.js',
    'vendor/tesseract-core-lstm.wasm.js',
    'vendor/tesseract-core-lstm.wasm',
    'vendor/tesseract-core-simd-lstm.wasm.js',
    'vendor/tesseract-core-simd-lstm.wasm',
    'languages/eng.traineddata.gz'
  ];
  const permitted = new Set(names.map(name => new URL(name, base).href));
  function check(value) {
    const url = new URL(typeof value === 'string' || value instanceof URL ? value : value?.url, self.location.href);
    // Pinned local Tesseract core inlines its own WASM bytes as a data URL.
    // This is in-memory module data (not a network destination). Allow ONLY
    // bounded base64 octet-stream, never remote/blob/HTML/script data URLs.
    // The JS that generates it is hashed before OCR is started by ocr-runtime.
    if (url.protocol === 'data:' && url.pathname.length >= 100_000 &&
        url.pathname.length <= 6_000_000 &&
        /^application\/octet-stream;base64,(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(url.pathname)) {
      return url.href;
    }
    if (!permitted.has(url.href)) throw new Error('Local OCR unavailable.');
    return url.href;
  }
  const originalImportScripts = self.importScripts.bind(self);
  self.importScripts = (...sources) => originalImportScripts(...sources.map(check));
  const originalFetch = self.fetch.bind(self);
  self.fetch = (source, options) => {
    check(source);
    return originalFetch(source, options);
  };
  if (typeof self.XMLHttpRequest === 'function') {
    const originalOpen = self.XMLHttpRequest.prototype.open;
    self.XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      if (method !== 'GET') throw new Error('Local OCR unavailable.');
      return originalOpen.call(this, method, check(url), ...rest);
    };
  }
  // Model progress/diagnostic strings must never enter extension or browser logs.
  for (const name of ['log', 'info', 'warn', 'error', 'debug']) {
    try { self.console[name] = () => {}; } catch { /* best effort */ }
  }
  self.importScripts(new URL('vendor/worker.min.js', base).href);
})();
