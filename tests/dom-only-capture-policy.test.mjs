import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const worker = await readFile(new URL('../extension/service-worker.js', import.meta.url), 'utf8');
const context = vm.createContext({
  URL, performance, AbortController,
  chrome: {
    runtime: { onMessage: { addListener() {} } },
    storage: { sync: { get: async () => ({}) } }
  }
});
vm.runInContext(worker, context);
const shouldCapture = vm.runInContext('visualObservationEnabled', context);
const acceptsVisualStability = vm.runInContext('usableVisualStability', context);

test('ordinary commands retain screenshot proof; only the bounded Amazon product fast path is DOM-only', () => {
  for (const command of ['Scroll down', 'scroll up', 'go back', 'Back!', ' SCROLL DOWN ']) {
    assert.equal(shouldCapture(command, { includeScreenshot: true }), true, command);
  }
  for (const command of ['inspect this page', 'click search', 'submit the form',
    'scroll down and click login', 'open example.com', 'search for laptops']) {
    assert.equal(shouldCapture(command, { includeScreenshot: true }), true, command);
  }
  assert.equal(shouldCapture('inspect this page', { includeScreenshot: false }), false);
  assert.equal(shouldCapture('inspect this page', { includeScreenshot: true }, true), false);
});

test('visual quiet pacing accepts only fixed-shape local metadata and never replaces capture proof', () => {
  const stable = {
    ok: true, url: 'https://www.amazon.in/', documentToken: 'opaque-local-token',
    domRevision: 7, geometryRevision: 3, redactionCount: 12,
    redactionDigest: 'a1b2c3d4', visibleTextDigest: '11223344', controlDigest: '55667788',
    viewport: { width: 1280, height: 720, devicePixelRatio: 1.25 },
  };
  assert.equal(acceptsVisualStability(stable, 'https://www.amazon.in/?tracking=ignored'), true);
  for (const candidate of [
    { ...stable, url: 'https://other.example/' },
    { ...stable, redactionCount: 501 },
    { ...stable, redactionDigest: 'not-a-digest' },
    { ...stable, viewport: { ...stable.viewport, devicePixelRatio: 0 } },
    { ...stable, documentToken: '' },
    { ...stable, ok: false },
  ]) assert.equal(acceptsVisualStability(candidate, 'https://www.amazon.in/'), false);
});
