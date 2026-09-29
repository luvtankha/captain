import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const asset = path => readFile(new URL(`../extension/${path}`, import.meta.url));

test('packaged UltraFace source asset has the pinned model digest and license', async () => {
  const model = await asset('faces/ultraface-rfb-320.onnx');
  const license = (await asset('faces/ULTRAFACE-LICENSE.txt')).toString('utf8');
  assert.equal(model.byteLength, 1_163_666);
  assert.equal(createHash('sha256').update(model).digest('hex'),
    'd7c687949526065ab6a192fdf993360045ce27b0fabf7c9fca5c2437b786b495');
  assert.match(license, /MIT License/);
});

test('the browser-local ONNX/WASM runtime and license are present', async () => {
  for (const name of ['vendor/ort.min.js', 'vendor/ort-wasm-simd-threaded.mjs', 'vendor/ort-wasm-simd-threaded.wasm']) {
    const bytes = await asset(name);
    assert.ok(bytes.byteLength > 10, `${name} unavailable`);
  }
  assert.match((await asset('vendor/ONNXRUNTIME-LICENSE.txt')).toString('utf8'), /MIT License/);
});

test('packager rejects missing or modified vision assets before ZIP generation', async () => {
  const source = (await readFile(new URL('../tools/package.mjs', import.meta.url))).toString('utf8');
  assert.match(source, /createHash\('sha256'\)/);
  assert.match(source, /Bundled UltraFace model identity mismatch/);
  assert.match(source, /Required packaged vision asset is unavailable/);
  assert.match(source, /vision-worker\.js/);
});
