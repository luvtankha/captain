import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const core = await readFile(new URL('../extension/privacy/privacy-core.js', import.meta.url), 'utf8');
const worker = await readFile(new URL('../extension/service-worker.js', import.meta.url), 'utf8');
function harness({ loadCore = true, runtimeId = 'synthetic-extension' } = {}) {
  const stored = [];
  const sandbox = {
    URL, AbortController, performance, setTimeout, clearTimeout,
    chrome: {
      runtime: { id: runtimeId, onMessage: { addListener() {} } },
      storage: { local: { async set(value) { stored.push(value); } } },
    },
  };
  vm.createContext(sandbox);
  if (loadCore) vm.runInContext(core, sandbox);
  vm.runInContext(worker, sandbox);
  return { sandbox, stored };
}

test('packaged privileged worker refuses to construct egress without on-device privacy core', () => {
  const h = harness({ loadCore: false });
  assert.throws(() => h.sandbox.sanitizeCommand('ordinary public search'), /privacy engine unavailable/i);
  assert.throws(() => h.sandbox.sanitizePayload({ task: 'ordinary public search' }), /privacy engine unavailable/i);
});

test('same task typed placeholders survive recursive payload redaction without raw personal canaries', () => {
  const { sandbox } = harness();
  const privateEmail = 'phase03@example.test';
  const privateToken = `sk-test-${'x'.repeat(24)}`;
  const first = sandbox.sanitizeCommand(`Contact ${privateEmail}`);
  const safe = sandbox.sanitizePayload({
    task: `Contact ${privateEmail}`,
    context: { pageText: `Contact ${privateEmail}; token: ${privateToken}` },
    history: [{ reason: `Contact ${privateEmail}` }],
  });
  assert.match(first, /\[EMAIL_1\]/);
  assert.match(JSON.stringify(safe), /\[EMAIL_1\]/);
  assert.doesNotMatch(JSON.stringify(safe), /phase03@example\.test|sk-test-/);
  assert.match(safe.context.pageText, /\[(?:TOKEN|API_KEY)_\d+\]/);
});

test('unknown opaque material and private planner output fail closed before action or history', () => {
  const { sandbox } = harness();
  assert.throws(() => sandbox.sanitizeCommand(`Reference ${'AB09'.repeat(10)}`), /withheld locally/i);
  assert.throws(() => sandbox.assertNoPrivatePlannerText({ action: { type: 'type', value: 'phase03@example.test' } }), /private text/i);
  assert.throws(() => sandbox.assertNoPrivatePlannerText({ action: { type: 'navigate', url: 'https://example.test/?token=synthetic-secret-foo' } }), /private text/i);
  assert.doesNotThrow(() => sandbox.assertNoPrivatePlannerText({ action: { type: 'click', target: { ref: 'c1' } } }));
});
test('strict trusted screenshot and DOM integrity hashes survive real recursive egress redaction', () => {
  const { sandbox } = harness();
  const digest = 'd29b6210d171e3dc5454e09847aaabce6a0255eaefa565b639e1301a9e933ef9';
  const safe = sandbox.sanitizePayload({ context: {
    pageMetadata: { domFingerprint: '0a13beef', visibleTextHash: 'a012f2de',
      sanitizedScreenshotFingerprint: digest },
    screenshotMetadata: { sha256: digest },
    pageText: 'Contact synthetic@example.test'
  } });
  assert.equal(safe.context.pageMetadata.sanitizedScreenshotFingerprint, digest);
  assert.equal(safe.context.screenshotMetadata.sha256, digest);
  assert.equal(safe.context.pageMetadata.domFingerprint, '0a13beef');
  assert.match(safe.context.pageText, /\[EMAIL_1\]/);
  for (const [key, value] of [['sha256', 'ABCD'.repeat(16)],
    ['sanitizedScreenshotFingerprint', 'PRIVATE_TOKEN'],
    ['domFingerprint', 'sk-test-not-a-fingerprint'],
    ['visibleTextHash', 'abc']]) {
    assert.throws(() => sandbox.sanitizePayload({ [key]: value }), /integrity identifier/i);
  }
  assert.throws(() => sandbox.sanitizePayload({ unrelated: 'AB09'.repeat(10) }), /withheld locally/i);
});
test('planner history allowlists an action and result without echoing server timing/unknown fields', () => {
  const { sandbox } = harness();
  const plan = { action: { type: 'scroll', direction: 'down', amount: 650 },
    reason: 'Scroll the current page', planner: 'fast-command',
    serverLatencyMs: 7, serverTiming: { plannerMs: 3 }, unreviewed: 'should-not-echo' };
  const entry = sandbox.plannerHistoryEntry(plan, { ok: true });
  assert.deepEqual(Object.keys(entry).sort(), ['action', 'planner', 'reason', 'result']);
  assert.equal(entry.action.type, 'scroll');
  assert.equal(entry.result.ok, true);
  assert.doesNotMatch(JSON.stringify(entry), /serverTiming|serverLatencyMs|unreviewed|should-not-echo/);
  assert.doesNotThrow(() => sandbox.sanitizePayload({ history: [entry] }));
  assert.throws(() => sandbox.plannerHistoryEntry({ action: plan.action },
    { message: 'AB09'.repeat(10) }), /withheld locally/i);
});

test('session clearing rotates typed placeholder mappings between independent tasks', () => {
  const { sandbox } = harness();
  assert.match(sandbox.sanitizeCommand('phase03-one@example.test'), /\[EMAIL_1\]/);
  assert.match(sandbox.sanitizeCommand('phase03-two@example.test'), /\[EMAIL_2\]/);
  sandbox.clearPrivacySession();
  assert.match(sandbox.sanitizeCommand('phase03-two@example.test'), /\[EMAIL_1\]/);
});

test('local status and event telemetry never persist raw canary strings', async () => {
  const { sandbox, stored } = harness();
  const timeline = [];
  sandbox.timelineEvent(timeline, performance.now(), 'PLAN_RECEIVED', { model: 'phase03@example.test', provider: `sk-test-${'x'.repeat(24)}` });
  await sandbox.state({ status: 'running', task: 'phase03@example.test', message: `sk-test-${'x'.repeat(24)}`, history: [{ result: { message: 'phase03@example.test' } }] });
  const all = JSON.stringify({ timeline, stored });
  assert.doesNotMatch(all, /phase03@example\.test|sk-test-/);
  assert.match(all, /\[EMAIL_1\]/);
});
