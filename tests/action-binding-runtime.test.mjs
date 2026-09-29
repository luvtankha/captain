import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const root = new URL('../extension/', import.meta.url);
const [worker, classic, entry, manifestText] = await Promise.all([
  readFile(new URL('service-worker.js', root), 'utf8'),
  readFile(new URL('action-binding-runtime.js', root), 'utf8'),
  readFile(new URL('action-binding-entry.js', root), 'utf8'),
  readFile(new URL('manifest.json', root), 'utf8'),
]);

test('generated binding gate is usable as a classic script for Firefox and Chrome side-effect loader', () => {
  const sandbox = { URL, performance };
  vm.runInNewContext(classic, sandbox);
  assert.equal(typeof sandbox.CAPTAIN_ACTION_BINDING.validateActionOnDevice, 'function');
  assert.equal(typeof sandbox.CAPTAIN_ACTION_BINDING.invalidateTaskBinding, 'function');
  assert.equal(sandbox.CAPTAIN_ACTION_BINDING.ACTION_BINDING_TTL_MS, 120000);
  const manifest = JSON.parse(manifestText);
  assert.equal(manifest.background.service_worker, 'action-binding-entry.js');
  assert.match(entry, /import '\.\/action-binding-runtime\.js';[\s\S]*import '\.\/service-worker\.js';/);
});

test('actual privileged worker path refuses plans when the action binding runtime is absent', async () => {
  const sandbox = {
    URL, performance, AbortController,
    chrome: { runtime: { id: 'test-extension-id', onMessage: { addListener() {} } } },
  };
  vm.runInNewContext(worker, sandbox);
  await assert.rejects(
    sandbox.validatePlannedActionOnDevice({ action: { type: 'finish', message: 'Done' } },
      { url: 'https://example.test/', elements: [] }, { id: 7, windowId: 3, url: 'https://example.test/' }, {}),
    /action binding is unavailable/i,
  );
});

test('privileged worker calls the packaged local gate before a planned action', async () => {
  let called = 0;
  const sandbox = {
    URL, performance, AbortController,
    CAPTAIN_ACTION_BINDING: {
      validateActionOnDevice(plan, observation, lease) {
        called++;
        assert.equal(observation.url, 'https://example.test/');
        assert.equal(observation.tabId, lease.tabId);
        return { action: plan.action };
      },
      invalidateTaskBinding() {},
    },
    chrome: {
      runtime: { id: 'test-extension-id', onMessage: { addListener() {} } },
      tabs: { get: async () => ({ id: 7, windowId: 3, incognito: true, url: 'https://example.test/' }) },
    },
  };
  vm.runInNewContext(worker, sandbox);
  const tab = { id: 7, windowId: 3, url: 'https://example.test/' };
  const context = { url: tab.url, elements: [], pageMetadata: { domFingerprint: 'abcdef01' } };
  const lease = sandbox.mintLocalActionLease(tab, context, 1);
  await sandbox.validatePlannedActionOnDevice({ action: { type: 'finish', message: 'Done' } }, context, tab, lease);
  assert.equal(called, 1);
});
