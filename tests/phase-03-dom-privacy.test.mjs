import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';

const root = new URL('../extension/', import.meta.url);
const [core, content, manifestText] = await Promise.all([
  readFile(new URL('privacy/privacy-core.js', root), 'utf8'),
  readFile(new URL('content-script.js', root), 'utf8'),
  readFile(new URL('manifest.json', root), 'utf8'),
]);
const canary = 'OpaqueZ99Q8m77Y6v55P4t33R2s11T0u';
const bounds = { x: 12, y: 24, left: 12, top: 24, right: 230, bottom: 54, width: 218, height: 30 };

function runtime({ title = 'Public catalog', bodyText = 'Public listing', paragraph = '', visualLabel = '', loadCore = true } = {}) {
  let receiver;
  const listeners = new Map();
  const document = {
    title, readyState: 'complete', visibilityState: 'visible', images: [],
    documentElement: {},
    addEventListener(type, fn) { listeners.set(type, fn); },
    removeEventListener(type) { listeners.delete(type); },
    dispatchEvent(event) { listeners.get(event.type)?.(event); },
    querySelector(selector) { return selector === '#captain-agent-host' ? { remove() {} } : null; },
    querySelectorAll(selector) {
      if (selector === 'h1,h2,h3,p,th,td,label,[role="heading"]' && paragraph) return [textNode];
      if (selector === 'img,canvas,video,iframe,frame,embed,object,[role="img"],article,[role="dialog"],[role="menu"]' && visualLabel) return [visualNode];
      return [];
    },
  };
  document.body = { innerText: bodyText, ownerDocument: document };
  const textNode = {
    tagName: 'P', innerText: paragraph, textContent: paragraph, ownerDocument: document,
    getAttribute() { return null; }, getBoundingClientRect() { return bounds; }, closest() { return null; },
  };
  const visualNode = {
    tagName: 'ARTICLE', ownerDocument: document, alt: '',
    getAttribute(name) { return name === 'aria-label' ? visualLabel : null; },
    getBoundingClientRect() { return bounds; }, closest() { return null; },
  };
  class MutationObserver {
    observe() {}
    takeRecords() { return []; }
    disconnect() {}
  }
  const address = new URL('https://public.example.test/catalog');
  const sandbox = {
    URL, crypto: webcrypto, performance, MutationObserver, Date,
    Event: class { constructor(type) { this.type = type; } },
    setTimeout, clearTimeout, setInterval, clearInterval,
    innerWidth: 1000, innerHeight: 800, devicePixelRatio: 1,
    addEventListener(type, fn) { listeners.set('global:' + type, fn); },
    removeEventListener(type) { listeners.delete('global:' + type); },
    getComputedStyle: () => ({ visibility: 'visible', display: 'block', opacity: '1', backgroundImage: 'none' }),
    location: { href: address.href, origin: address.origin, hostname: address.hostname, pathname: address.pathname },
    document,
    chrome: { runtime: { id: 'synthetic-extension-id', onMessage: {
      addListener(fn) { receiver = fn; }, removeListener() { receiver = undefined; },
    } } },
  };
  sandbox.window = sandbox;
  document.defaultView = sandbox;
  const context = vm.createContext(sandbox);
  if (loadCore) vm.runInContext(core, context, { filename: 'privacy-core.js' });
  vm.runInContext(content, context, { filename: 'content-script.js' });
  const send = message => new Promise((resolve, reject) => {
    try { receiver(message, {}, resolve); } catch (error) { reject(error); }
  });
  return {
    send, context, document,
    pagehide() { listeners.get('global:pagehide')?.(); },
    dispose() { context.__captainPageController?.dispose(); },
  };
}

test('manifest starts shared classic privacy core before content script', () => {
  const manifest = JSON.parse(manifestText);
  assert.deepEqual(manifest.content_scripts[0].js, ['privacy/privacy-core.js', 'content-script.js']);
  assert.match(content, /privacyCore\.createSession\(\)/);
});

test('real runtime without shared engine fails closed with no observation or readiness data', async () => {
  const page = runtime({ loadCore: false });
  try {
    for (const type of ['OBSERVE', 'READINESS']) {
      const result = await page.send({ type });
      assert.equal(typeof result.error, 'string');
      assert.equal(result.elements, undefined);
      assert.equal(result.pageText, undefined);
      assert.equal(result.url, undefined);
    }
  } finally { page.dispose(); }
});

test('real runtime redacts known PII across body, nested text and visual labels with typed placeholders', async () => {
  const email = 'synthetic.person@example.test';
  const page = runtime({
    bodyText: `Public catalog contact ${email}`,
    paragraph: `Contact ${email}`,
    visualLabel: `Article contact ${email}`,
  });
  try {
    const observation = await page.send({ type: 'OBSERVE' });
    assert.equal(observation.error, undefined);
    assert.match(observation.pageText, /\[EMAIL_1\]/);
    assert.match(observation.textRegions[0].text, /\[EMAIL_1\]/);
    assert.match(observation.visualRegions[0].text, /\[EMAIL_1\]/);
    assert.doesNotMatch(JSON.stringify(observation), /synthetic\.person@example\.test/);
    assert.equal(observation.pageMetadata.observationId.length, 32);
  } finally { page.dispose(); }
});

test('opaque token in page title blocks OBSERVE with generic error and no planner payload', async () => {
  const page = runtime({ title: `Public catalog ${canary}` });
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await page.send({ type: 'OBSERVE' });
      assert.deepEqual(Object.keys(response), ['error']);
      assert.match(response.error, /privacy check failed/i);
      assert.doesNotMatch(JSON.stringify(response), new RegExp(canary));
    }
    const readiness = await page.send({ type: 'READINESS' });
    assert.deepEqual(Object.keys(readiness), ['error']);
  } finally { page.dispose(); }
});

test('opaque token in page text blocks entire observation even when title and controls are public', async () => {
  const page = runtime({ bodyText: `Public listing ${canary}`, paragraph: 'Public listing' });
  try {
    const response = await page.send({ type: 'OBSERVE' });
    assert.deepEqual(Object.keys(response), ['error']);
    assert.match(response.error, /privacy check failed/i);
    assert.doesNotMatch(JSON.stringify(response), new RegExp(canary));
    assert.equal(response.elements, undefined);
    assert.equal(response.pageText, undefined);
    assert.equal(response.title, undefined);
  } finally { page.dispose(); }
});

test('pagehide clears session and invalidates old observation while allowing a new public observation', async () => {
  const page = runtime();
  try {
    const before = await page.send({ type: 'OBSERVE' });
    assert.equal(before.error, undefined);
    page.pagehide();
    const after = await page.send({ type: 'OBSERVE' });
    assert.equal(after.error, undefined);
    assert.notEqual(after.pageMetadata.observationId, before.pageMetadata.observationId);
    assert.ok(after.pageMetadata.domRevision > before.pageMetadata.domRevision);
  } finally { page.dispose(); }
});
