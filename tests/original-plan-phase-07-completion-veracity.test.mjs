import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../extension/service-worker.js', import.meta.url), 'utf8');
const sandbox = { URL, performance, setTimeout, clearTimeout,
  chrome: { runtime: { onMessage: { addListener() {} } } } };
vm.createContext(sandbox);
vm.runInContext(source, sandbox);
const completionSummary = vm.runInContext('completionSummary', sandbox);
const done = { action: { type: 'finish', message: 'The requested action was executed.' }, planner: 'fast-command' };
const result = { ok: true, done: true, message: 'The requested action was executed.' };

test('a blocked task asking for clarification retains its blocked verdict', () => {
  const plan = { action: { type: 'finish', completionStatus: 'BLOCKED',
    clarification: 'Please identify the target.', message: 'Visual target masked.' }, planner: 'fast-command' };
  const status = completionSummary(plan, { ok: true, message: 'Visual target masked.' });
  assert.equal(status.completionStatus, 'BLOCKED');
  assert.equal(status.outcomeVerified, false);
});

test('a model-selected click followed by deterministic finish remains PARTIAL without semantic evidence', () => {
  const history = [
    { action: { type: 'click', target: { ref: 'c1' } }, planner: 'ollama', result: { ok: true } },
    { ...done, result },
  ];
  const status = completionSummary(done, result, undefined, history);
  assert.equal(status.completionStatus, 'PARTIAL');
  assert.equal(status.outcomeVerified, false);
  assert.match(status.message, /not been independently verified/i);
  assert.doesNotMatch(status.message, /COMPLETED/i);
});

test('a model-selected action may be completed only with independent verification', () => {
  const history = [
    { action: { type: 'click', target: { ref: 'c1' } }, planner: 'ollama', result: { ok: true } },
    { ...done, result },
  ];
  assert.equal(completionSummary(done, result, { verified: true }, history).completionStatus, 'COMPLETED');
  assert.equal(completionSummary(done, result, { verified: false }, history).completionStatus, 'PARTIAL');
});

test('a deterministic action without a model retains its existing completion contract', () => {
  assert.equal(completionSummary(done, result, undefined, [{ ...done, result }]).completionStatus, 'COMPLETED');
});
