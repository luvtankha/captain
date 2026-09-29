import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../extension/vision-host.js', import.meta.url), 'utf8');
const popupSource = await readFile(new URL('../extension/popup.js', import.meta.url), 'utf8');
const start = source.indexOf('let visionWorker, visionSequence = 0;');
const end = source.length;
assert.ok(start > 0 && end > start, 'Shared extension-only worker path could not be extracted.');

function fixture({ throwOnPost = false } = {}) {
  const workers = [], events = [];
  class Worker {
    constructor(url) { this.url = url; this.terminated = false; workers.push(this); }
    postMessage(message) {
      if (throwOnPost) throw new Error('synthetic raw diagnostic must stay local');
      this.id = message.id;
      this.lastPosted = message;
      events.push('posted');
    }
    terminate() { this.terminated = true; events.push('terminated'); }
    reply(ok, result = {}) { this.onmessage({ data: { id: this.id, ok, result } }); }
  }
  const sandbox = { Worker, Map, setTimeout, clearTimeout,
    chrome: { runtime: { getURL: path => `chrome-extension://synthetic/${path}` } } };
  vm.createContext(sandbox);
  vm.runInContext(source.slice(start, end), sandbox);
  return { workers, events, run: message => sandbox.runLocalVision(message) };
}

const input = () => ({ screenshot: 'synthetic-masked-fixture', viewport: { width: 1, height: 1 },
  redactionBoxes: [{ kind: 'RASTER_CONTENT' }] });

test('successful visual reply releases the worker before the next capture', async () => {
  const h = fixture();
  const pending = h.run(input());
  assert.equal(h.workers.length, 1);
  h.workers[0].reply(true, { visualPrivacy: { schema: 'captain.visual-privacy.v2' } });
  assert.equal((await pending).visualPrivacy.schema, 'captain.visual-privacy.v2');
  assert.equal(h.workers[0].terminated, true);
  const next = h.run(input());
  assert.equal(h.workers.length, 2);
  h.workers[1].reply(true);
  await next;
  assert.equal(h.workers[1].terminated, true);
});

test('synthetic OCR gate diagnostics require explicit internal opt-in and no raw text fields', async () => {
  const h = fixture();
  const normal = h.run(input());
  assert.equal(Object.hasOwn(h.workers[0].lastPosted, 'auditGateOnly'), false);
  h.workers[0].reply(true);
  await normal;
  const audit = h.run({ ...input(), auditGateOnly: true });
  assert.equal(h.workers[1].lastPosted.auditGateOnly, true);
  assert.equal(Object.hasOwn(h.workers[1].lastPosted, 'words'), false);
  assert.equal(Object.hasOwn(h.workers[1].lastPosted, 'diagnosticText'), false);
  h.workers[1].reply(true);
  await audit;
});

test('failed inference discards the worker and does not reveal untrusted diagnostics', async () => {
  const h = fixture();
  const pending = h.run(input());
  h.workers[0].reply(false, { error: 'synthetic raw diagnostic must stay local' });
  await assert.rejects(pending, error => error.message === 'Local visual privacy failed.');
  assert.equal(h.workers[0].terminated, true);
  const next = h.run(input());
  assert.equal(h.workers.length, 2);
  h.workers[1].reply(true);
  await next;
});

test('overlapping requests keep one worker until all pending replies are resolved', async () => {
  const h = fixture(), first = h.run(input()), firstId = h.workers[0].id;
  const second = h.run(input()), secondId = h.workers[0].id;
  assert.notEqual(firstId, secondId);
  h.workers[0].onmessage({ data: { id: firstId, ok: true, result: { ok: true } } });
  await first;
  assert.equal(h.workers[0].terminated, false);
  h.workers[0].onmessage({ data: { id: secondId, ok: true, result: { ok: true } } });
  await second;
  assert.equal(h.workers[0].terminated, true);
});

test('worker postMessage errors clear the timer and release the failed worker', async () => {
  const h = fixture({ throwOnPost: true });
  await assert.rejects(h.run(input()), error => error.message === 'Local visual privacy failed.');
  assert.equal(h.workers[0].terminated, true);
});

test('late error from an already terminated worker cannot kill its replacement', async () => {
  const h = fixture();
  const first = h.run(input());
  const old = h.workers[0];
  old.reply(true);
  await first;
  assert.equal(old.terminated, true);
  const second = h.run(input());
  const current = h.workers[1];
  old.onerror({ message: 'synthetic private worker diagnostics' });
  old.onmessage({ data: { id: current.id, ok: false } });
  assert.equal(current.terminated, false);
  current.reply(true, { visualPrivacy: { schema: 'captain.visual-privacy.v2' } });
  assert.equal((await second).visualPrivacy.schema, 'captain.visual-privacy.v2');
  assert.equal(current.terminated, true);
});

test('a transient or foreign-window popup does not receive a screenshot job', async () => {
  const start = popupSource.indexOf('chrome.runtime.onMessage?.addListener?');
  const end = popupSource.indexOf("$('#run').onclick", start);
  assert.ok(start >= 0 && end > start);
  for (const controllerWindow of [undefined, 18]) {
    let listener, jobs = 0, replies = 0;
    const sandbox = { windowId: controllerWindow, Number, chrome: { runtime: { onMessage: {
      addListener(callback) { listener = callback; }
    } } }, runLocalVision: async () => { jobs++; return { screenshot: 'masked' }; } };
    vm.createContext(sandbox);
    vm.runInContext(popupSource.slice(start, end), sandbox);
    const response = () => replies++;
    assert.equal(listener({ type: 'VISION_REDACT', windowId: 19 }, null, response), undefined);
    assert.equal(jobs, 0);
    if (controllerWindow === 18) {
      assert.equal(listener({ type: 'VISION_REDACT', windowId: 18 }, null, response), true);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(jobs, 1);
      assert.equal(replies, 1);
    }
  }
});
