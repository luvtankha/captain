import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { adapter, syntheticRaster, lease, EXPECTED_SHA } from '../tools/phase-06-real-inference.mjs';
import { evaluate } from '../tools/phase-06-evaluate.mjs';
import { decodePng } from '../tools/phase-06-real-inference.mjs';
import { runInNewContext } from 'node:vm';

const asset = await readFile(new URL('../extension/controls/model.onnx', import.meta.url));

test('actual pinned ONNX/WASM model executes on generated UI raster without external calls or text output', async () => {
  assert.equal(createHash('sha256').update(asset).digest('hex'), EXPECTED_SHA);
  const client = adapter();
  const image = syntheticRaster();
  const actual = await client.detector.detect(image, image.width, image.height, lease);
  assert.equal(client.runs(), 1);
  assert.equal(actual.complete, true);
  assert.equal(actual.modelSha256, EXPECTED_SHA);
  assert.equal(actual.source, 'ui-element-onnx');
  assert.equal(actual.width, 640);
  assert.equal(actual.height, 640);
  assert.deepEqual(Object.keys(actual).sort(), ['complete','detections','height','lease','modelSha256','source','width'].sort());
  assert.equal(actual.detections.length <= 64, true);
  assert.doesNotMatch(JSON.stringify(actual), /demo@example\.test|selector|embedding|value|password/);
});

test('missing and corrupt local checkpoints both stop before inference with generic errors', async () => {
  const image = syntheticRaster();
  const absent = adapter({ missing: true });
  await assert.rejects(absent.detector.detect(image, image.width, image.height, lease), /^Error: Local UI detector unavailable\.$/);
  assert.equal(absent.runs(), 0);
  const corrupt = Buffer.from(asset); corrupt[corrupt.length - 12] ^= 1;
  const damaged = adapter({ bytes: corrupt });
  await assert.rejects(damaged.detector.detect(image, image.width, image.height, lease), /^Error: Local UI detector unavailable\.$/);
  assert.equal(damaged.runs(), 0);
});

test('wrong source dimensions and malformed lease cannot invoke real checkpoint', async () => {
  const image = syntheticRaster(), client = adapter();
  await assert.rejects(client.detector.detect(image, 639, 640, lease), /Local UI detector unavailable/);
  await assert.rejects(client.detector.detect(image, 640, 640, { ...lease, domRevision: NaN }), /Local UI detector unavailable/);
  assert.equal(client.runs(), 0);
});

test('genuine Node-hosted fixture has no matches at the required 0.75 threshold', async () => {
  const measured = await evaluate();
  assert.equal(measured.actualModelRuns, 1);
  assert.equal(measured.groundTruthCount, 9);
  assert.equal(measured.predictions, 0);
  assert.equal(measured.truePositive, 0);
  assert.equal(measured.falsePositive, 0);
  assert.equal(measured.falseNegative, 9);
  assert.equal(measured.precision, null);
  assert.equal(measured.recall, 0); // Browser-native inference is the authoritative UI score.
});

test('genuine checkpoint zero output forces blackout despite a fresh DOM ref', async () => {
  const png = await readFile(new URL('../benchmarks/phase-06-isolated-ui.png', import.meta.url))
    .catch(error => { if (error?.code === 'ENOENT') return null; throw error; });
  const pixels = png ? decodePng(png) : syntheticRaster(), client = adapter();
  const actual = await client.detector.detect(pixels, pixels.width, pixels.height, lease);
  assert.equal(client.runs(), 1);
  assert.equal(actual.detections.length, 0);
  const fusionSource = await readFile(new URL('../extension/controls/ui-fusion.js', import.meta.url), 'utf8');
  const sandbox = {}; sandbox.globalThis = sandbox; runInNewContext(fusionSource, sandbox);
  const control = { ref: 'c7', source: 'dom', visible: true, enabled: true, sensitive: true,
    box: { x: 287, y: 543, width: 148.5, height: 44 }, lease };
  const input = { result: actual, controls: [control], lease, modelSha256: EXPECTED_SHA,
    width: pixels.width, height: pixels.height,
    viewport: { width: pixels.width, height: pixels.height, devicePixelRatio: 1 },
    ocrPlan: { fullBlackout: false, regions: [] } };
  const mask = sandbox.CaptainUIFusion.review(input);
  assert.equal(mask.fullBlackout, true);
  assert.equal(mask.regions.length, 0);
  assert.equal(JSON.stringify(mask).includes('demo@example.test'), false);
  assert.deepEqual(Array.from(mask.matchedRefs), []);
  const invalid = sandbox.CaptainUIFusion.review({ ...input, controls: [] });
  assert.equal(invalid.fullBlackout, true); // no model-only target
  assert.deepEqual(Array.from(invalid.regions), []);
  const stale = sandbox.CaptainUIFusion.review({ ...input, controls: [{ ...control, lease: { ...lease, geometryRevision: 2 } }] });
  assert.equal(stale.fullBlackout, true);
  const uncertain = sandbox.CaptainUIFusion.review({ ...input, ocrPlan: { fullBlackout: true, regions: [] } });
  assert.equal(uncertain.fullBlackout, true);
});
