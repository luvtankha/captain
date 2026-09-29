import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('../extension/controls/ui-fusion.js', import.meta.url), 'utf8');
const hash = 'a'.repeat(64);
const lease = { documentToken: 'local-doc-12345', observationId: 'local-obs-12345', domRevision: 3, geometryRevision: 5 };
const viewport = { width: 100, height: 50, devicePixelRatio: 2 };
const box = { x1: 20, y1: 10, x2: 60, y2: 30 };
const control = { ref: 'c7', source: 'dom', visible: true, enabled: true, sensitive: false,
  lease, box: { x: 10, y: 5, width: 20, height: 10 } };

function fuse(change = {}) {
  const ctx = {}; ctx.globalThis = ctx; runInNewContext(source, ctx);
  const input = {
    lease, modelSha256: hash, width: 200, height: 100, viewport,
    ocrPlan: { fullBlackout: false, regions: [] }, controls: [control],
    result: { complete: true, source: 'ui-element-onnx', modelSha256: hash,
      width: 200, height: 100, lease,
      detections: [{ kind: 'control', confidence: 0.92, box }] }, ...change
  };
  return JSON.parse(JSON.stringify(ctx.CaptainUIFusion.review(input)));
}

test('only current genuine DOM ref can be fused, without creating a new control', () => {
  assert.deepEqual(fuse(), { fullBlackout: false, matchedRefs: ['c7'], regions: [] });
});
test('existing sensitive control receives widened opaque region, not text', () => {
  const result = fuse({ controls: [{ ...control, sensitive: true }] });
  assert.deepEqual(result, { fullBlackout: false, matchedRefs: ['c7'], regions: [box] });
  assert.doesNotMatch(JSON.stringify(result), /text|label|value|embedding|selector/i);
});
test('model-only icon without genuine DOM cN blackens rather than creating an action target', () => {
  assert.equal(fuse({ controls: [] }).fullBlackout, true);
});
test('ambiguous overlapping DOM controls fail closed', () => {
  const second = { ...control, ref: 'c8' };
  assert.equal(fuse({ controls: [control, second] }).fullBlackout, true);
});
test('duplicate detections for one cN fail closed', () => {
  const detection = { kind: 'control', confidence: 0.92, box };
  assert.equal(fuse({ result: { complete: true, source: 'ui-element-onnx', modelSha256: hash,
    width: 200, height: 100, lease, detections: [detection, detection] } }).fullBlackout, true);
});
test('invalid source, checkpoint, dimensions and model lease fail closed', () => {
  const base = { complete: true, source: 'ui-element-onnx', modelSha256: hash,
    width: 200, height: 100, lease, detections: [{ kind: 'control', confidence: 0.91, box }] };
  for (const changed of [
    { source: 'dom' }, { modelSha256: 'f'.repeat(64) }, { width: 640 },
    { lease: { ...lease, observationId: 'stale-obs-12345' } }, { complete: false }
  ]) assert.equal(fuse({ result: { ...base, ...changed } }).fullBlackout, true);
});
test('stale DOM revision or forged ref fails closed', () => {
  for (const bad of [{ ...control, lease: { ...lease, geometryRevision: 99 } },
    { ...control, ref: 'c0' }, { ...control, source: 'model' }]) {
    assert.equal(fuse({ controls: [bad] }).fullBlackout, true);
  }
});
test('model output fields for raw text, embeddings, selectors or suggested refs fail closed', () => {
  const base = { kind: 'control', confidence: 0.92, box };
  for (const field of ['text', 'embedding', 'selector', 'ref', 'privateValue']) {
    assert.equal(fuse({ result: { complete: true, source: 'ui-element-onnx', modelSha256: hash,
      width: 200, height: 100, lease, detections: [{ ...base, [field]: 'canary@example.test' }] } }).fullBlackout, true);
  }
});
test('unsafe confidence, invalid rectangles or unknown transforms black out', () => {
  for (const change of [{ confidence: 0.1 }, { confidence: NaN }, { confidence: 1.5 },
    { box: { ...box, x2: 250 } }, { box: { ...box, x1: 80 } },
    { transform: 'rotate(30deg)' }]) {
    assert.equal(fuse({ result: { complete: true, source: 'ui-element-onnx', modelSha256: hash,
      width: 200, height: 100, lease, detections: [{ kind: 'control', confidence: 0.92, box, ...change }] } }).fullBlackout, true);
  }
});
test('bad DPR/screenshot scale and unsupported screenshot dimensions fail closed', () => {
  assert.equal(fuse({ viewport: { ...viewport, devicePixelRatio: 1 } }).fullBlackout, true);
  assert.equal(fuse({ width: 13_000 }).fullBlackout, true);
  assert.equal(fuse({ viewport: { ...viewport, width: 200 } }).fullBlackout, true);
});
test('OCR uncertain/full-blackout can never be overridden by model confidence', () => {
  assert.equal(fuse({ ocrPlan: { fullBlackout: true, regions: [] } }).fullBlackout, true);
});
test('empty/overflow model output is not evidence of a safe image', () => {
  for (const detections of [[], Array.from({ length: 65 }, () => ({ kind: 'control', confidence: 0.9, box }))]) {
    assert.equal(fuse({ result: { complete: true, source: 'ui-element-onnx', modelSha256: hash,
      width: 200, height: 100, lease, detections } }).fullBlackout, true);
  }
});
test('missing controls, missing lease or unbounded DOM list fail closed', () => {
  assert.equal(fuse({ controls: null }).fullBlackout, true);
  assert.equal(fuse({ lease: null }).fullBlackout, true);
  assert.equal(fuse({ controls: Array.from({ length: 251 }, (_, i) => ({ ...control, ref: `c${i + 1}` })) }).fullBlackout, true);
});
