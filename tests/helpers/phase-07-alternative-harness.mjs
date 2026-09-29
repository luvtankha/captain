import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import * as ort from 'onnxruntime-web';

const dir = new URL('../../extension/entities/', import.meta.url);
const [tokenizerCode, runtimeCode] = await Promise.all([
  readFile(new URL('wordpiece.js', dir), 'utf8'),
  readFile(new URL('pii-runtime.js', dir), 'utf8')
]);
ort.env.wasm.numThreads = 1;
ort.env.wasm.simd = true;
export function input(text, index) {
  return { text, confidence: 99,
    bbox: { x0: index * 60 + 1, y0: 8, x1: index * 60 + 58, y1: 24 } };
}
export function context(overrides = {}) {
  const requests = [];
  const sandbox = {
    URL, ArrayBuffer, Uint8Array, BigInt64Array, BigInt, Number, Map, Set, TextDecoder,
    crypto: webcrypto, setTimeout, clearTimeout, ort,
    self: { location: { href: 'chrome-extension://captain-test/vision-worker.js' } },
    async fetch(address) {
      requests.push(String(address));
      const url = new URL(address);
      if (url.protocol !== 'chrome-extension:') throw Error('Remote fetch forbidden.');
      const filename = url.pathname.split('/').at(-1);
      if (!['model.quant.onnx', 'config.json', 'vocab.txt'].includes(filename)) throw Error('Unapproved asset.');
      const contents = await readFile(new URL(filename, dir));
      const bytes = overrides[filename] ?? contents;
      return { ok: true, arrayBuffer: async () =>
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
    }
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(tokenizerCode, sandbox);
  vm.runInContext(runtimeCode, sandbox);
  return { runtime: sandbox.CaptainAlternativePII, requests };
}
