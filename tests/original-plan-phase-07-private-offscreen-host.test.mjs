import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const swSource = await readFile(new URL('../extension/service-worker.js', import.meta.url), 'utf8');
const hostSource = await readFile(new URL('../extension/offscreen.js', import.meta.url), 'utf8');
const extensionBase = 'chrome-extension://synthetic-extension/';

function privilegedFixture({ normal = 0, privateCount = 0, failCreate = false, unsupported = false } = {}) {
  let created = 0, closed = 0;
  const contexts = incognito => Array.from({ length: incognito ? privateCount : normal },
    (_, i) => ({ contextType: 'OFFSCREEN_DOCUMENT', incognito, documentId: `${incognito ? 'private' : 'normal'}-${i}` }));
  const runtime = { id: 'synthetic-extension', getURL: path => extensionBase + path,
    getContexts: async filter => contexts(filter.incognito), onMessage: { addListener() {} } };
  const offscreen = { createDocument: async () => { created++;
    if (failCreate) throw new Error('synthetic private diagnostic never surfaces');
    normal = 1; }, closeDocument: async () => { closed++; normal = 0; } };
  const sandbox = { URL, AbortController, performance, setTimeout, clearTimeout,
    chrome: { runtime, ...(unsupported ? {} : { offscreen }) } };
  vm.createContext(sandbox); vm.runInContext(swSource, sandbox);
  return { sandbox, calls: () => ({ created, closed }) };
}

test('normal offscreen worker is created exactly once and reused across observations', async () => {
  const f = privilegedFixture();
  assert.equal(await f.sandbox.ensurePrivateVisionHost(), true);
  assert.equal(await f.sandbox.ensurePrivateVisionHost(), true);
  assert.equal(f.calls().created, 1);
});

test('Incognito offscreen context, duplicate normal context and host failure all deny before any screenshot dispatch', async () => {
  for (const f of [privilegedFixture({ privateCount: 1 }), privilegedFixture({ normal: 2 }), privilegedFixture({ failCreate: true })]) {
    await assert.rejects(() => f.sandbox.ensurePrivateVisionHost());
    assert.equal(f.calls().closed, 0);
  }
});

test('a runtime lacking the Chrome offscreen API uses the existing popup worker fallback', async () => {
  assert.equal(await privilegedFixture({ unsupported: true }).sandbox.ensurePrivateVisionHost(), false);
});

test('offscreen host rejects website/content-script and other extension page messages before starting a worker', async () => {
  let listener, jobs = 0, replies = 0;
  const sandbox = { document: { hidden: false }, performance, setTimeout,
    chrome: { runtime: { id: 'synthetic-extension', getURL: path => extensionBase + path,
      onMessage: { addListener: fn => { listener = fn; } } } },
    runLocalVision: async () => { jobs++; return { screenshot: 'synthetic-masked-fixture' }; } };
  vm.createContext(sandbox); vm.runInContext(hostSource, sandbox);
  const request = { type: 'VISION_REDACT', visionHost: 'offscreen' };
  const respond = () => replies++;
  const trusted = { id: 'synthetic-extension', url: extensionBase + 'action-binding-entry.js' };
  for (const sender of [
    { ...trusted, tab: { id: 1 } }, { ...trusted, url: extensionBase + 'popup.html' },
    { ...trusted, id: 'another-extension' },
  ]) assert.equal(listener(request, sender, respond), undefined);
  assert.equal(listener({ ...request, visionHost: 'popup' }, trusted, respond), undefined);
  assert.equal(jobs, 0);
  assert.equal(listener(request, trusted, respond), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(jobs, 1);
  assert.equal(replies, 1);
});
