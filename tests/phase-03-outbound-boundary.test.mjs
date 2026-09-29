import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeObservation, assertSafeToTransmit } from '../server/outbound-contract.mjs';
import { sanitizeMetricSample } from '../server/metrics.mjs';
import { payloadLeaks } from '../server/privacy.mjs';

const base = () => ({
  task: 'Inspect synthetic public controls',
  context: {
    url: 'https://fixture.example.test/form', title: 'Example form',
    pageText: 'Public fixture content',
    elements: [{ ref: 'c1', tag: 'input', type: 'email', name: 'Email', value: '[EMAIL_1]', sensitive: true, sensitiveType: 'secret', source: 'dom' }],
    sensitiveRegions: [{ id: 's1', type: 'EMAIL', bbox: { x: 1, y: 2, width: 20, height: 10 }, confidence: 1, source: 'DOM_PRIVACY' }],
    piiCounts: { EMAIL: 1 },
  }, history: [],
});

test('Phase-03 typed placeholders and canonical privacy-region categories pass allowlisted egress', () => {
  for (const kind of ['EMAIL','PHONE','PAN','AADHAAR','CARD','API_KEY','TOKEN','PASSWORD','OTP','PIN','CREDENTIAL','PERSON','ADDRESS','ACCOUNT']) {
    const raw = base();
    raw.context.sensitiveRegions[0].type = kind;
    raw.context.piiCounts = { [kind]: 1 };
    const safe = sanitizeObservation(raw);
    assert.equal(safe.context.sensitiveRegions[0].type, kind);
    assert.equal(safe.context.piiCounts, undefined, 'Only category counts are accepted and then discarded');
    assert.deepEqual(assertSafeToTransmit(safe), safe);
  }
});

test('unrecognized/unknown privacy region blocks even if supplied text has a safe placeholder', () => {
  for (const kind of ['UNKNOWN','FUTURE_UNVERIFIED_DETECTOR']) {
    const raw = base();
    raw.context.sensitiveRegions[0].type = kind;
    assert.throws(() => sanitizeObservation(raw), /privacy review or blocked/);
  }
});

test('critical synthetic canaries never enter task, page text, element fields or history', () => {
  const canaries = [
    'phase03@example.test', '9876543210', 'ABCDE1234F', '4111 1111 1111 1111',
    'Bearer synthetic-token-1234567890', `sk-test-${'x'.repeat(24)}`,
    'CANARY_private_value', 'name: Synthetic Person',
    'password: synthetic-passphrase', 'https://fixture.example.test/?token=synthetic-secret',
  ];
  for (const critical of canaries) {
    const raw = base(); raw.context.pageText = critical;
    assert.throws(() => sanitizeObservation(raw), /Outbound contract rejected/, `page text leak: ${critical.slice(0, 8)}`);
    const inTask = base(); inTask.task = critical;
    assert.throws(() => sanitizeObservation(inTask), /Outbound contract rejected/, `task leak: ${critical.slice(0, 8)}`);
    const inElement = base(); inElement.context.elements[0].name = critical;
    assert.throws(() => sanitizeObservation(inElement), /Outbound contract rejected/, `element leak: ${critical.slice(0, 8)}`);
    const inHistory = base(); inHistory.history = [{ action: { type: 'wait' }, reason: critical }];
    assert.throws(() => sanitizeObservation(inHistory), /Outbound contract rejected/, `history leak: ${critical.slice(0, 8)}`);
  }
});

test('encoded identifiers and URL parameters are withheld, even when raw field contains only a URL', () => {
  for (const badUrl of [
    'https://fixture.example.test/?token=synthetic-secret',
    'https://fixture.example.test/#password=synthetic-secret',
    'https://fixture.example.test/path/person%40example.test',
    'https://fixture.example.test/path?%74oken=synthetic-secret',
  ]) {
    const raw = base(); raw.context.url = badUrl;
    assert.throws(() => sanitizeObservation(raw), /Outbound contract rejected/);
  }
});

test('metrics and scanner refuse raw canary fields instead of retaining or logging them', () => {
  for (const bad of [
    { latencyMs: 1, task: 'CANARY_secret' },
    { vision: { mode: 'synthetic@example.test', details: 'CANARY_secret' } },
    { steps: '9876543210' },
  ]) assert.throws(() => sanitizeMetricSample(bad), /Invalid|Unexpected/);
  const sample = sanitizeMetricSample({ latencyMs: 12, piiDetected: 8, steps: 2 });
  assert.equal(payloadLeaks(sample).length, 0);
  assert.doesNotMatch(JSON.stringify(sample), /CANARY|synthetic@example.test/);
});
