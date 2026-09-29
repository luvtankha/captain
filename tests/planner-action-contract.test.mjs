import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePlan } from '../server/planner.mjs';

test('planner accepts a grounded hover action so the device can enforce its current ref', () => {
  const action = { type: 'hover', target: { ref: 'c1' } };
  assert.equal(validatePlan({ action, reason: 'Inspect observed control' }).action, action);
  for (const target of [undefined, {}, { ref: 'c0' }, { ref: 'c01' }, { ref: '#synthetic' }]) {
    assert.throws(() => validatePlan({ action: { type: 'hover', target }, reason: 'Synthetic' }), /observed|invalid/i);
  }
});
