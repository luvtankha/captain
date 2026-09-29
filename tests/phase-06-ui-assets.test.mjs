import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';

const root = new URL('../extension/controls/', import.meta.url);
const bridge = await readFile(new URL('ui-model.js', root), 'utf8');
const notice = await readFile(new URL('NOTICE.txt', root), 'utf8');
const worker = await readFile(new URL('../extension/vision-worker.js', import.meta.url), 'utf8');
const device = await readFile(new URL('../extension/service-worker.js', import.meta.url), 'utf8');
const privateVisionHost = await readFile(new URL('../extension/vision-host.js', import.meta.url), 'utf8');
const packageSource = await readFile(new URL('../tools/package.mjs', import.meta.url), 'utf8');

const SHA = 'd29b6210d171e3dc5454e09847aaabce6a0255eaefa565b639e1301a9e933ef9';
test('installed real UI model gate identifies the exact checkpoint and does not invent output', async () => {
  const ctx = {}; ctx.globalThis = ctx; runInNewContext(bridge, ctx);
  assert.equal(ctx.CaptainUIModel.ready, true);
  assert.equal(ctx.CaptainUIModel.modelSha256, SHA);
  assert.match(ctx.CaptainUIModel.quantization, /FP32/);
  await assert.rejects(ctx.CaptainUIModel.detect(), /^Error: Local UI detector unavailable\.$/);
  assert.equal(Object.isFrozen(ctx.CaptainUIModel), true);
});
test('packaging pins the genuine 7.5 MB UI ONNX by size/hash and rejects other weights', async () => {
  assert.match(packageSource, /Pinned local UI detector integrity, license or runtime contract failed/);
  assert.match(packageSource, /ready: true/);
  const model = await readFile(new URL('model.onnx', root));
  assert.equal(model.length, 7481347);
  assert.equal(createHash('sha256').update(model).digest('hex'), SHA);
  const entries = await readdir(root);
  assert.deepEqual(entries.filter(name => /\.(?:onnx|pt|pth|safetensors|bin|gguf)$/i.test(name)), ['model.onnx']);
  assert.match(packageSource, /phase-06-live-worker\.js/);
  assert.match(packageSource, /phase-06-live-ocr-worker\.js/);
  assert.match(packageSource, /phase06-debug-runtime\.js/);
});
test('notice discloses AGPL YOLOv5 lineage instead of treating upstream MIT tag as sufficient', async () => {
  assert.match(notice, /AGPL-3\.0/);
  assert.match(notice, /model card declares MIT/);
  assert.match(notice, /not quantized/);
  assert.match(notice, new RegExp(SHA));
  assert.match(await readFile(new URL('ATTRIBUTION.txt', root), 'utf8'), /yolov5n\.pt/);
  assert.match(await readFile(new URL('YOLOV5-AGPL-3.0-LICENSE.txt', root), 'utf8'), /GNU AFFERO GENERAL PUBLIC LICENSE/);
});
test('UI model is on-demand screenshot-only, and raw detections do not join outbound proof', () => {
  assert.match(worker, /controls\/ui-model\.js.*controls\/ui-fusion\.js/);
  assert.match(worker, /CaptainUIModel\?\.ready === true/);
  assert.match(worker, /candidate\?\.fullBlackout === false/);
  assert.doesNotMatch(worker, /uiPlan\.fullBlackout/);
  assert.match(worker, /cannot authorize source-pixel release/);
  assert.match(worker, /8000/);
  assert.match(device, /uiSnapshot: localUISnapshot\(context\)/);
  assert.match(privateVisionHost, /uiSnapshot: message\.uiSnapshot/);
  assert.doesNotMatch(worker.slice(worker.indexOf('return {\n    screenshot:')), /matchedRefs|detections|embeddings|ocrPlan/);
});
