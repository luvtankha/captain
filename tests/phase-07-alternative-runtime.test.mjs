import test from 'node:test';
import assert from 'node:assert/strict';
import { context, input } from './helpers/phase-07-alternative-harness.mjs';

test('original-publisher independent model has a separate, active local bridge', () => {
  const { runtime } = context();
  assert.equal(runtime.ready, true);
  assert.equal(runtime.modelSha256, 'b227845ff4989c9f7383874b841895dfbdb9a4d7a20ceb39c3f187271894bf2a');
  assert.equal(typeof runtime.detect, 'function');
});

test('real ONNX/WASM inference masks ambiguous email words without text egress', async () => {
  const { runtime, requests } = context();
  const words = ['Contact', 'Jane', 'Doe', 'at', 'jane.doe@example.com.'].map(input);
  const result = await runtime.detect(words, 500, 60);
  // The real model emits ambiguous tokens in this fixture. Their word boxes
  // are opaque; a valid model uncertainty need not blacken unrelated pixels.
  assert.equal(result.fullBlackout, false);
  assert.equal(result.regions.length > 0, true);
  assert.doesNotMatch(JSON.stringify(result), /Jane|Doe|example|wordIndex|score|logits|token/i);
  assert.equal(requests.length, 3);
  for (const url of requests) assert.match(url, /^chrome-extension:\/\/captain-test\/entities\//);
});

test('real ONNX/WASM inference accepts an unambiguous public synthetic token sequence', async () => {
  const { runtime } = context();
  const result = await runtime.detect(['Hello', 'world.'].map(input), 500, 60);
  assert.equal(result.fullBlackout, false);
  assert.equal(result.regions.length, 0);
});

test('no OCR, low-confidence OCR, non-Latin text and invalid bounds force blackout', async () => {
  const { runtime } = context();
  for (const words of [
    [], [input('public', 0), { ...input('private', 1), confidence: 50 }],
    [input('नमस्ते', 0)], [{ ...input('hi', 0), bbox: { x0: NaN, y0: 8, x1: 20, y1: 24 } }]
  ]) {
    const result = await runtime.detect(words, 500, 60);
    assert.equal(result.fullBlackout, true);
    assert.equal(result.regions.length, 0);
  }
});

test('tampered model or config cannot authorize readable screenshot pixels', async () => {
  for (const file of ['model.quant.onnx', 'config.json']) {
    const { runtime } = context({ [file]: Buffer.from('tampered') });
    const result = await runtime.detect([input('ordinary', 0)], 500, 60);
    assert.equal(result.fullBlackout, true);
    assert.equal(result.regions.length, 0);
  }
});
