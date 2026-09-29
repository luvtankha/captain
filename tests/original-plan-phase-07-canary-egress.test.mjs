// Original master-plan Phase 7 acceptance: synthetic canaries across every
// reviewed browser -> companion text/metadata channel. No live accounts,
// capture bytes, private values or bootstrap credentials are recorded.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { sanitizeObservation, assertSafeToTransmit } from '../server/outbound-contract.mjs';
import { sanitizeMetricSample, sanitizeVisualAudit } from '../server/metrics.mjs';
import { payloadLeaks } from '../server/privacy.mjs';
import { enforceActionPrivacy } from '../extension/action-security.mjs';
import { validatePlan } from '../server/planner.mjs';

const [coreSource, workerSource] = await Promise.all([
  readFile(new URL('../extension/privacy/privacy-core.js', import.meta.url), 'utf8'),
  readFile(new URL('../extension/service-worker.js', import.meta.url), 'utf8'),
]);

// These are deliberately synthetic, recognisable critical canary classes;
// assertions and success output expose counts/categories, not their values.
const canaries = Object.freeze([
  { kind: 'email', value: 'phase07-fixture@example.test' },
  { kind: 'phone', value: '+91 9876543210' },
  { kind: 'pan', value: 'ABCDE1234F' },
  { kind: 'card', value: '4111 1111 1111 1111' },
  { kind: 'api-key', value: `sk-test-${'x'.repeat(32)}` },
  { kind: 'bearer', value: `Bearer ${'z'.repeat(30)}` },
  { kind: 'password', value: 'password: synthetic-only-passphrase' },
  { kind: 'unknown', value: 'AB09'.repeat(10) },
  { kind: 'marker', value: 'CANARY_phase07_fixture_only' },
]);

const base = () => ({
  task: 'Review public controls',
  context: {
    url: 'https://fixture.example.test/form', title: 'Public fixture',
    pageText: 'Visible public test page', searchQuery: 'public search',
    elements: [{ ref: 'c1', tag: 'input', type: 'text', name: 'Public search',
      placeholder: 'Search products', source: 'dom', sensitive: false }],
  }, history: [],
});

function privilegedWorker() {
  const stored = [];
  const sandbox = {
    URL, AbortController, performance, setTimeout, clearTimeout,
    chrome: { runtime: { id: 'synthetic-extension', onMessage: { addListener() {} } },
      storage: { local: { async set(value) { stored.push(value); } } } },
  };
  vm.createContext(sandbox);
  vm.runInContext(coreSource, sandbox);
  vm.runInContext(workerSource, sandbox);
  return { sandbox, stored };
}

function absent(value, source, surface) {
  assert.equal(JSON.stringify(value).includes(source), false,
    `A synthetic private value reached ${surface}.`);
}

test('all seeded critical canary classes are withheld before typed task, page, element and history egress', () => {
  const locations = [
    raw => { raw.task = '__CANARY__'; },
    raw => { raw.context.title = '__CANARY__'; },
    raw => { raw.context.pageText = '__CANARY__'; },
    raw => { raw.context.searchQuery = '__CANARY__'; },
    raw => { raw.context.elements[0].name = '__CANARY__'; },
    raw => { raw.context.elements[0].placeholder = '__CANARY__'; },
    raw => { raw.history = [{ action: { type: 'wait' }, reason: '__CANARY__' }]; },
    raw => { raw.history = [{ action: { type: 'wait' }, result: { message: '__CANARY__' } }]; },
  ];
  for (const canary of canaries) for (let surface = 0; surface < locations.length; surface++) {
    const raw = base();
    locations[surface](raw);
    // Replace only the deliberately seeded fixture marker, not the schema.
    const attack = structuredClone(raw);
    function replace(node) {
      if (typeof node === 'string') return node === '__CANARY__' ? canary.value : node;
      if (Array.isArray(node)) return node.map(replace);
      if (node && typeof node === 'object') return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, replace(v)]));
      return node;
    }
    const input = replace(attack);
    let outgoing;
    try { outgoing = assertSafeToTransmit(sanitizeObservation(input)); }
    catch { continue; } // Fail closed is allowed; raw canary must not pass.
    absent(outgoing, canary.value, `outbound field ${surface} (${canary.kind})`);
  }
});

test('private or percent-encoded URL/query/fragment strings cannot enter the planner context', () => {
  for (const url of [
    'https://fixture.example.test/?token=synthetic-private-token',
    'https://fixture.example.test/?%74oken=synthetic-private-token',
    'https://fixture.example.test/#password=synthetic-private-token',
    'https://fixture.example.test/path/person%40example.test',
  ]) {
    const input = base(); input.context.url = url;
    assert.throws(() => assertSafeToTransmit(sanitizeObservation(input)), /Outbound contract rejected/);
  }
});

test('privileged extension projects canaries to placeholders or withholds the entire payload', () => {
  for (const canary of canaries) {
    const { sandbox } = privilegedWorker();
    let safe;
    try {
      safe = sandbox.sanitizePayload({ task: `Review ${canary.value}`,
        context: { pageText: `Visible ${canary.value}` },
        history: [{ reason: `Saw ${canary.value}` }] });
    } catch (error) {
      absent({ message: error.message }, canary.value, 'generic sanitization error');
      continue;
    }
    absent(safe, canary.value, `privileged payload (${canary.kind})`);
  }
});

test('untrusted planner output cannot reintroduce canaries into actions, status or history', async () => {
  for (const canary of canaries) {
    const { sandbox, stored } = privilegedWorker();
    let allowed = false;
    try { sandbox.assertNoPrivatePlannerText({ action: { type: 'type', target: { ref: 'c1' }, value: canary.value } }); allowed = true; }
    catch { /* A denial is expected for recognizable private text. */ }
    if (allowed) {
      // For a value not recognized as private, still enforce the sensitive
      // target's independent device-side prohibition.
      assert.throws(() => enforceActionPrivacy({ type: 'type', target: { ref: 'c1' }, value: canary.value },
        [{ ref: 'c1', sensitive: true, sensitiveType: 'password' }]), /blocked/i);
    }
    await sandbox.state({ status: 'running', task: canary.value,
      message: canary.value, history: [{ result: { message: canary.value } }] });
    absent(stored, canary.value, `status/history (${canary.kind})`);
  }
  assert.throws(() => validatePlan({ action: { type: 'request_local_input',
    target: { ref: 'c1' }, inputType: 'password', value: 'synthetic' } }), /never contain/);
});

test('bounded operational telemetry and visual audit never persist supplied private fields', () => {
  for (const canary of canaries) {
    assert.throws(() => sanitizeMetricSample({ latencyMs: 1, task: canary.value }), /Unexpected/);
    assert.throws(() => sanitizeMetricSample({ vision: { status: 'sanitized', rawText: canary.value } }), /Unexpected/);
    const audit = sanitizeVisualAudit({ schema: 'captain.visual-privacy.v2', sanitized: true,
      rawScreenshotTransmitted: false, faces: 0, note: canary.value });
    absent(audit, canary.value, `visual audit (${canary.kind})`);
  }
  const { sandbox } = privilegedWorker();
  const timeline = [];
  sandbox.timelineEvent(timeline, performance.now(), 'PLAN_RECEIVED', {
    provider: 'phase07-fixture@example.test', model: 'CANARY_phase07_fixture_only',
    error: 'CANARY_phase07_fixture_only',
  });
  absent(timeline, 'phase07-fixture@example.test', 'timeline');
  absent(timeline, 'CANARY_phase07_fixture_only', 'timeline');
});

test('unproved, corrupted or legacy screenshot cannot be released by a sanitized flag or digest alone', () => {
  const raw = 'data:image/jpeg;base64,/9j/AA==';
  for (const visual of [
    { screenshot: raw },
    { screenshot: raw, visualPrivacy: { sanitized: true, rawScreenshotTransmitted: false } },
    { screenshot: raw, visualPrivacy: { schema: 'captain.visual-privacy.v1', sanitized: true } },
    { screenshot: raw, screenshotMetadata: { sanitized: true, format: 'image/jpeg' } },
  ]) {
    const input = base(); Object.assign(input.context, visual);
    assert.throws(() => assertSafeToTransmit(sanitizeObservation(input)), /Outbound contract rejected/);
    assert.equal(payloadLeaks({ context: { screenshot: raw } }).some(item => item.kind === 'unverified_screenshot'), true);
  }
});

test('recognizable critical canaries do not enter metrics, audit or planner request from a trusted public-only payload', () => {
  const safe = assertSafeToTransmit(sanitizeObservation(base()));
  assert.deepEqual(payloadLeaks({ task: safe.task, context: safe.context, history: safe.history }), []);
  for (const canary of canaries) absent(safe, canary.value, 'positive-control planner request');
  const sample = sanitizeMetricSample({ latencyMs: 12, piiDetected: 0, steps: 2 });
  for (const canary of canaries) absent(sample, canary.value, 'positive-control metric');
});
