import test from 'node:test';
import assert from 'node:assert/strict';
import { iou, matchControls, matchKinds, summarize, rates } from '../tools/phase-08-score.mjs';

test('geometry uses independent one-to-one IoU rather than min(count) false positives', () => {
  const box = { x: 10, y: 10, width: 40, height: 20 };
  assert.equal(iou(box, box), 1);
  assert.equal(iou(box, { ...box, x: 200 }), 0);
  const truth = [{ tag: 'button', bbox: box },
    { tag: 'input', bbox: { ...box, y: 60 } }];
  const observed = [{ tag: 'button', bbox: { ...box, x: 200 } },
    { tag: 'input', bbox: { ...box, y: 60 } }];
  const score = matchControls(truth, observed);
  assert.deepEqual({ tp: score.tp, fp: score.fp, fn: score.fn }, { tp: 1, fp: 1, fn: 1 });
  const duplicate = matchControls([truth[1]], [observed[1], observed[1]]);
  assert.equal(duplicate.tp, 1); assert.equal(duplicate.fp, 1);
});

test('kind multiset retains duplicate emails and counts unknown/missing kinds as errors', () => {
  assert.deepEqual(matchKinds(['EMAIL','EMAIL','PHONE'],['PHONE','EMAIL','API_KEY']),
    { tp: 2, fp: 1, fn: 1 });
});

test('quantiles are sampled, not guessed, and empty samples do not become 100 percent', () => {
  assert.deepEqual(summarize([3,1,2,5,4]), { count: 5, meanMs: 3, p50Ms: 3, p95Ms: 5 });
  assert.equal(summarize([]).p95Ms, null);
  assert.deepEqual(rates({ tp: 1, fp: 1, fn: 3 }), { tp: 1, fp: 1, fn: 3, precision: .5, recall: .25 });
});
