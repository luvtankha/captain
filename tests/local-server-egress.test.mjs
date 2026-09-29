import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const worker = await readFile(new URL('../extension/service-worker.js', import.meta.url), 'utf8');

function loadWorker(serverUrl = 'http://127.0.0.1:4317') {
  const requests = [];
  const stateWrites = [];
  const sandbox = {
    URL, performance, AbortController,
    fetch: async url => { requests.push(String(url)); throw new Error('A network request was unexpectedly attempted.'); },
    chrome: {
      runtime: { id: 'synthetic-extension-id', onMessage: { addListener() {} } },
      storage: {
        sync: { get: async () => ({ serverUrl, maxSteps: 1, includeScreenshot: false }) },
        local: { set: async value => { stateWrites.push(value); } },
      },
    },
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(worker, context);
  return {
    requests, stateWrites,
    normalize: vm.runInContext('normalizeLoopbackServerUrl', context),
    run: vm.runInContext('run', context),
  };
}

test('local planner destination accepts an explicitly configured loopback port', () => {
  const { normalize } = loadWorker();
  const result = new URL(normalize('http://127.0.0.1:55231'));
  assert.equal(result.origin, 'http://127.0.0.1:55231');
  assert.equal(result.pathname, '/');
  assert.equal(result.search, '');
  assert.equal(result.hash, '');
  assert.equal(result.username, '');
  assert.equal(result.password, '');
});

test('planner destination blocks remote hosts, credentials, misleading hostnames and appended paths', () => {
  const { normalize } = loadWorker();
  const unsafe = [
    'https://remote.example.test',
    'http://192.168.1.10:4317',
    'http://127.0.0.1.evil.test:4317',
    'http://localhost.evil.test:4317',
    'http://user:synthetic@127.0.0.1:4317',
    'http://127.0.0.1@evil.test:4317',
    'http://127.0.0.1:4317/synthetic-path',
    'http://127.0.0.1:4317/?token=synthetic',
    'http://127.0.0.1:4317/#synthetic',
    'file:///synthetic',
  ];
  for (const destination of unsafe) {
    assert.throws(() => normalize(destination), undefined, `accepted unsafe planner URL: ${destination}`);
  }
});

test('unsafe planner configuration stops a task before agent or telemetry requests', async () => {
  for (const serverUrl of [
    'https://remote.example.test',
    'http://127.0.0.1.evil.test:4317',
    'http://user:synthetic@127.0.0.1:4317',
  ]) {
    const runtime = loadWorker(serverUrl);
    await runtime.run('synthetic local test');
    assert.deepEqual(runtime.requests, [], `network request occurred for ${serverUrl}`);
    assert.equal(runtime.stateWrites.at(-1)?.captainState?.status, 'error');
    assert.match(runtime.stateWrites.at(-1)?.captainState?.message || '', /server|endpoint|loopback|local|url|address|host/i);
  }
});
