import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';

// Synthetic DOM adapter. These checks exercise the actual content script in a
// privileged-runtime-shaped VM, but they are not browser/layout accuracy proof.
const source = await readFile(new URL('../extension/content-script.js', import.meta.url), 'utf8');
const privacyCore = await readFile(new URL('../extension/privacy/privacy-core.js', import.meta.url), 'utf8');
const fixture = async name => JSON.parse(await readFile(new URL(`./fixtures/perception/${name}.json`, import.meta.url), 'utf8'));
const plain = value => JSON.parse(JSON.stringify(value));
const box = ([x = 0, y = 0, width = 0, height = 0] = []) => ({ x, y, left: x, top: y, width, height, right: x + width, bottom: y + height });
const SELECTORS = /\s*,\s*/;

function matchesSimple(node, pattern) {
  let selector = pattern.trim();
  if (!selector) return false;
  const negative = selector.match(/:not\((\[[^\]]+\])\)/);
  if (negative) {
    if (matchesSimple(node, negative[1])) return false;
    selector = selector.replace(negative[0], '');
  }
  if (selector === '*') return true;
  if (selector === 'body *') return node.tagName !== 'BODY';
  if (selector.startsWith('#')) return node.id === selector.slice(1);
  if (selector.startsWith('.')) return (node.getAttribute('class') || '').split(/\s+/).includes(selector.slice(1));
  const tag = selector.match(/^([a-z][\w-]*)/i)?.[1];
  if (tag && node.tagName !== tag.toUpperCase()) return false;
  const attrSpecs = [...selector.matchAll(/\[([\w-]+)(?:\s*(\*=|=)\s*["]?([\w-]+)["]?)?\]/g)];
  for (const [, key, mode, value] of attrSpecs) {
    const actual = node.getAttribute(key);
    if (actual === null || (mode === '=' && actual !== value) || (mode === '*=' && !actual.includes(value))) return false;
  }
  // Unsupported pseudo-classes/descendant selectors do not fabricate a match.
  const scrubbed = selector.replace(/^([a-z][\w-]*)?/i, '').replace(/\[[^\]]*\]/g, '');
  return !scrubbed.trim();
}

class SyntheticElement {
  constructor(data, ownerDocument, parent = null) {
    this.fixtureId = data.id || '';
    this.tagName = (data.tag || 'div').toUpperCase();
    this.attributes = { ...(data.attrs || {}) };
    this.id = this.attributes.id || data.id || '';
    this.attributes.id ??= this.id;
    this.parentElement = parent instanceof SyntheticElement ? parent : null;
    this.parentNode = parent;
    this.ownerDocument = ownerDocument;
    this.dataset = {};
    this.children = [];
    this._text = data.text || '';
    this._box = [...(data.box || [0, 0, 0, 0])];
    this.value = data.value || '';
    this.type = this.getAttribute('type') || '';
    this.name = this.getAttribute('name') || '';
    this.autocomplete = this.getAttribute('autocomplete') || '';
    this.placeholder = this.getAttribute('placeholder') || '';
    this.title = this.getAttribute('title') || '';
    this.ariaLabel = this.getAttribute('aria-label') || '';
    this.disabled = this.attributes.disabled !== undefined;
    this.readOnly = this.attributes.readonly !== undefined;
    this.hidden = this.attributes.hidden !== undefined;
    this.checked = this.attributes.checked !== undefined;
    this.selectedIndex = this.tagName === 'SELECT' ? 0 : undefined;
    this.options = [];
    this.labels = [];
    this.isConnected = true;
    this.clicks = 0;
    this.scrolls = 0;
    this.listeners = new Map();
  }
  get innerText() { return [this._text, ...this.children.map(child => child.innerText)].filter(Boolean).join(' ').trim(); }
  set innerText(value) { this._text = String(value); }
  get textContent() { return this.innerText; }
  set textContent(value) { this._text = String(value); }
  get href() { return this.getAttribute('href') || ''; }
  set href(value) { this.attributes.href = String(value); }
  get form() { return this.closest('form'); }
  get isContentEditable() { return this.getAttribute('contenteditable') === 'true'; }
  getAttribute(key) { return Object.hasOwn(this.attributes, key) ? String(this.attributes[key]) : null; }
  setAttribute(key, value) { this.attributes[key] = String(value); if (key === 'aria-label') this.ariaLabel = String(value); }
  removeAttribute(key) { delete this.attributes[key]; }
  getBoundingClientRect() { return box(this._box); }
  getClientRects() { return this._box[2] && this._box[3] ? [this.getBoundingClientRect()] : []; }
  matches(pattern) { return pattern.split(SELECTORS).some(part => matchesSimple(this, part)); }
  closest(pattern) { for (let el = this; el; el = el.parentElement) if (el.matches(pattern)) return el; return null; }
  querySelectorAll(pattern) { return descendants(this.children).filter(el => el.matches(pattern)); }
  querySelector(pattern) { return this.querySelectorAll(pattern)[0] || null; }
  getRootNode() { return this.parentNode?.getRootNode?.() || this.ownerDocument; }
  scrollIntoView() { this.scrolls++; }
  click() { this.clicks++; }
  focus() { this.focused = true; }
  addEventListener(type, fn) { const listeners = this.listeners.get(type) || []; listeners.push(fn); this.listeners.set(type, listeners); }
  dispatchEvent(event) { for (const fn of this.listeners.get(event.type) || []) fn(event); return true; }
}

function descendants(roots) {
  const all = [];
  for (const node of roots) { all.push(node); all.push(...descendants(node.children)); }
  return all;
}

function syntheticPage(data, { viewport = [1000, 800], dpr = 1, url = 'https://fixtures.example.test/demo' } = {}) {
  const address = new URL(url), nodes = new Map(), observers = [], listeners = new Map(), globalListeners = new Map(), queries = new Map();
  const document = {
    title: data.title, readyState: 'complete', visibilityState: 'visible', images: [],
    addEventListener(type, cb) { const list = listeners.get(type) || []; list.push(cb); listeners.set(type, list); },
    removeEventListener(type, cb) { listeners.set(type, (listeners.get(type) || []).filter(fn => fn !== cb)); },
    dispatchEvent(event) { for (const fn of listeners.get(event.type) || []) fn(event); },
    getElementById(id) { return this.querySelectorAll('*').find(el => el.id === id) || null; },
    // An existing inert panel keeps the fixture focused on page perception.
    querySelector(pattern) { if (pattern === '#captain-agent-host') return { remove() {} }; return this.querySelectorAll(pattern)[0] || null; },
    querySelectorAll(pattern) { queries.set(pattern, (queries.get(pattern) || 0) + 1); return descendants(this.body.children).filter(el => el.matches(pattern)); },
    createElement() { throw Error('The synthetic page does not permit CAPTAIN UI injection'); },
  };
  const body = new SyntheticElement({ id: 'body', tag: 'body', box: [0, 0, ...viewport] }, document);
  document.body = body;
  const sandbox = {
    URL, crypto: webcrypto, Event: class { constructor(type) { this.type = type; } },
    performance, innerWidth: viewport[0], innerHeight: viewport[1], devicePixelRatio: dpr,
    setTimeout, clearTimeout, setInterval, clearInterval,
    addEventListener(type, cb) { const list = globalListeners.get(type) || []; list.push(cb); globalListeners.set(type, list); },
    removeEventListener(type, cb) { globalListeners.set(type, (globalListeners.get(type) || []).filter(fn => fn !== cb)); },
    getComputedStyle: el => ({ display: el.hidden ? 'none' : 'block', visibility: 'visible', opacity: '1', backgroundImage: 'none' }),
    location: { href: address.href, origin: address.origin, hostname: address.hostname, pathname: address.pathname },
    document,
  };
  sandbox.window = sandbox;
  document.defaultView = sandbox;
  document.documentElement = { appendChild() {} };
  function build(items, parent = body, targetDoc = document) {
    for (const item of items) {
      const el = new SyntheticElement(item, targetDoc, parent);
      parent.children.push(el); nodes.set(item.id, el);
      if (item.shadow) {
        const root = { mode: 'open', host: el, children: [], querySelectorAll(pattern) { return descendants(this.children).filter(node => node.matches(pattern)); }, querySelector(pattern) { return this.querySelectorAll(pattern)[0] || null; }, getRootNode() { return this; } };
        el.shadowRoot = root;
        build(item.shadow, root, targetDoc);
      }
      if (item.frame) {
        const frameDoc = { ...document, images: [], defaultView: { ...sandbox, frameElement: el }, body: null };
        frameDoc.body = new SyntheticElement({ id: `${item.id}-body`, tag: 'body', box: [0, 0, el._box[2], el._box[3]] }, frameDoc);
        frameDoc.documentElement = frameDoc.body;
        frameDoc.querySelectorAll = pattern => descendants(frameDoc.body.children).filter(node => node.matches(pattern));
        frameDoc.querySelector = pattern => frameDoc.querySelectorAll(pattern)[0] || null;
        frameDoc.getElementById = id => frameDoc.querySelectorAll('*').find(node => node.id === id) || null;
        frameDoc.defaultView.addEventListener = () => {};
        el.contentWindow = frameDoc.defaultView;
        if (item.frame.accessible) { el.contentDocument = frameDoc; build(item.frame.nodes || [], frameDoc.body, frameDoc); }
        else Object.defineProperty(el, 'contentDocument', { get() { throw new DOMException('Cross-origin frame', 'SecurityError'); } });
      }
    }
  }
  build(data.nodes);
  document.images = [...nodes.values()].filter(el => el.tagName === 'IMG');
  for (const node of nodes.values()) if (node.tagName === 'INPUT' || node.tagName === 'TEXTAREA') {
    const label = [...nodes.values()].find(other => other.tagName === 'LABEL' && other.getAttribute('for') === node.id);
    if (label) node.labels = [label];
  }
  class MutationObserver {
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe(target, options) { this.target = target; this.options = options; }
    disconnect() { this.target = null; }
    takeRecords() { return []; }
  }
  sandbox.MutationObserver = MutationObserver;
  const messageListeners = new Set();
  sandbox.chrome = { runtime: { id: 'synthetic-captain-extension', onMessage: { addListener(fn) { messageListeners.add(fn); }, removeListener(fn) { messageListeners.delete(fn); } } } };
  const context = vm.createContext(sandbox);
  // A privileged extension runtime loads the shared on-device privacy engine
  // first, as its real manifest does. Preserve fail-closed runtime semantics.
  vm.runInContext(privacyCore, context);
  vm.runInContext(source, context);
  const send = message => new Promise((resolve, reject) => {
    const listener = [...messageListeners][0];
    if (!listener) return reject(Error('CAPTAIN listener not installed'));
    try { listener(message, {}, resolve); } catch (error) { reject(error); }
  });
  const emitMutation = (records = [{ type: 'childList', target: body, addedNodes: [], removedNodes: [] }]) => {
    for (const observer of observers) if (observer.target) observer.callback(records, observer);
  };
  function replace(id, options = {}) {
    const old = nodes.get(id), parent = old.parentElement;
    const index = parent.children.indexOf(old);
    const replacement = new SyntheticElement({ id, tag: old.tagName, text: old._text, attrs: { ...old.attributes }, value: old.value, box: old._box, ...options }, old.ownerDocument, parent);
    old.isConnected = false;
    parent.children[index] = replacement; nodes.set(id, replacement);
    emitMutation([{ type: 'childList', target: parent, addedNodes: [replacement], removedNodes: [old] }]);
    return { old, replacement };
  }
  return { sandbox, context, document, nodes, body, queries, send, emitMutation, replace,
    emitGlobal(type) { for (const fn of globalListeners.get(type) || []) fn({ type }); },
    dispose() { context.__captainPageController?.dispose(); } };
}

const guard = observation => {
  const { documentToken, domRevision, geometryRevision, observationId } = observation.pageMetadata || {};
  return { documentToken, domRevision, geometryRevision, observationId };
};

test('annotated login: labels, types and locally private credential fields', async () => {
  const spec = await fixture('login'), page = syntheticPage(spec);
  try {
    const observation = await page.send({ type: 'OBSERVE' });
    assert.equal(observation.error, undefined);
    const email = observation.elements.find(el => el.tag === 'input' && el.type === 'email');
    const password = observation.elements.find(el => el.type === 'password');
    const otp = observation.elements.find(el => el.sensitiveType === 'otp');
    assert.equal(email.sensitive, true);
    assert.match(email.associatedLabel || email.ariaLabel || '', /Email address/i);
    assert.equal(email.value, '[REDACTED_SECRET]');
    assert.equal(password.sensitive, true);
    assert.equal(otp.sensitive, true);
    assert.equal(password.value, '[REDACTED_SECRET]');
    assert.equal(otp.value, '[REDACTED_SECRET]');
    for (const sentinel of spec.annotations.noRemoteValues) assert.doesNotMatch(JSON.stringify(observation), new RegExp(sentinel));
    assert.ok(observation.sensitiveRegions.some(region => region.bbox.width > 0));
  } finally { page.dispose(); }
});

test('annotated search: autocomplete, role, state, link sanitization, and public value', async () => {
  const spec = await fixture('search'), page = syntheticPage(spec);
  try {
    const observation = await page.send({ type: 'OBSERVE' });
    const field = observation.elements.find(el => el.type === 'search');
    assert.equal(field.role, 'combobox');
    assert.match(field.name, /Search catalog/i);
    assert.equal(field.value, spec.annotations.publicValue);
    assert.equal(field.placeholder, 'Search public catalog');
    assert.equal(field.state.expanded, 'false');
    assert.equal(observation.elements.find(el => el.tag === 'a').href, spec.annotations.safeLink);
  } finally { page.dispose(); }
});

test('checkout lookalike is observed without purchasing and never exposes private or hidden values', async () => {
  const spec = await fixture('checkout-lookalike'), page = syntheticPage(spec);
  try {
    const observation = await page.send({ type: 'OBSERVE' });
    assert.equal(spec.annotations.noPurchase, true);
    for (const sentinel of spec.annotations.noRemoteValues) assert.doesNotMatch(JSON.stringify(observation), new RegExp(sentinel));
    for (const id of spec.annotations.sensitive) {
      const element = page.nodes.get(id), observed = observation.elements.find(el => el.ref === element.dataset.captainRef);
      assert.ok(observed?.sensitive, `${id} must be classified as sensitive`);
    }
    assert.ok(!observation.elements.some(el => el.type === 'hidden'));
    assert.equal(observation.elements.find(el => /Pay now/i.test(el.name))?.disabled, true);
    assert.equal(observation.elements.find(el => /Pay now/i.test(el.name))?.enabled, false);
    assert.equal(page.nodes.get('payDisabled').clicks, 0);
  } finally { page.dispose(); }
});

test('table text, contenteditable, role controls and bounded nearby semantics', async () => {
  const spec = await fixture('table'), page = syntheticPage(spec);
  try {
    const observation = await page.send({ type: 'OBSERVE' });
    for (const label of spec.annotations.tableText) assert.ok(observation.textRegions.some(region => region.text.includes(label)), label);
    const editable = observation.elements.find(el => el.role === 'textbox');
    assert.ok(editable, 'contenteditable public note has a control ref');
    assert.match(editable.associatedLabel, /Public notes/, 'aria-labelledby resolves within the actual root');
    const toggle = observation.elements.find(el => /Expand schedule/.test(el.name));
    assert.equal(toggle.state.expanded, 'false');
    for (const el of observation.elements) assert.ok((el.groupText || '').length <= 500);
  } finally { page.dispose(); }
});

test('canvas and inaccessible frame are visual-only; open shadow and readable frame have grounded semantics', async () => {
  const spec = await fixture('canvas-shadow-frame'), page = syntheticPage(spec);
  try {
    const observation = await page.send({ type: 'OBSERVE' });
    assert.ok(observation.visualRegions.some(region => /canvas/.test(region.role) || /pixels/i.test(region.text)));
    assert.ok(observation.redactionBoxes.some(region => region.kind === 'RASTER_CONTENT'));
    assert.ok(observation.elements.some(el => /Shadow search|Find in shadow/.test(el.name)), 'open shadow controls are reachable');
    assert.ok(observation.elements.some(el => /Frame query|Frame search/.test(el.name)), 'same-origin frame controls are reachable');
    const frameQuery = observation.elements.find(el => /Frame query/.test(el.name));
    assert.match(frameQuery.framePath, /frame\d+/);
    assert.ok(frameQuery.bbox.x >= 400 && frameQuery.bbox.x <= 700, 'frame-relative rectangle is mapped into top viewport CSS pixels');
    assert.ok(!observation.elements.some(el => /Inaccessible sample frame/.test(el.name)), 'cross-origin contents are never invented');
    const frameRegion = observation.visualRegions.find(region => /frame|iframe/i.test(region.role) && region.bbox.y >= 235);
    assert.ok(frameRegion, 'inaccessible frame retains visible region');
    assert.equal(frameRegion.confidence, 0);
    assert.match(frameRegion.text, /visual-only unknown/i);
  } finally { page.dispose(); }
});

test('document token is opaque, survives repeat observation, and changes on same-URL reload', async () => {
  const spec = await fixture('dynamic'), first = syntheticPage(spec), second = syntheticPage(spec);
  try {
    const a = await first.send({ type: 'OBSERVE' }), again = await first.send({ type: 'OBSERVE' }), reloaded = await second.send({ type: 'OBSERVE' });
    assert.match(a.pageMetadata.documentToken, /^[0-9a-f]{32}$/);
    assert.equal(again.pageMetadata.documentToken, a.pageMetadata.documentToken);
    assert.notEqual(reloaded.pageMetadata.documentToken, a.pageMetadata.documentToken);
    assert.notEqual(again.pageMetadata.observationId, a.pageMetadata.observationId);
    assert.equal(again.pageMetadata.domRevision, a.pageMetadata.domRevision);
    const staleRef = first.nodes.get('stable').dataset.captainRef;
    const replay = await second.send({ type: 'EXECUTE', observationGuard: guard(a), action: { type: 'click', target: { ref: staleRef } } });
    assert.equal(replay.ok, false, 'identical URL and control label cannot authorize a new document');
    assert.equal(second.nodes.get('stable').clicks, 0);
  } finally { first.dispose(); second.dispose(); }
});

test('guard rejects stale ref after same-looking node is swapped before guarded EXECUTE', async () => {
  const spec = await fixture('dynamic'), page = syntheticPage(spec);
  try {
    const old = await page.send({ type: 'OBSERVE' });
    const ref = page.nodes.get('stable').dataset.captainRef, oldGuard = guard(old);
    const { replacement } = page.replace('stable');
    const outcome = await page.send({ type: 'EXECUTE', observationGuard: oldGuard, action: { type: 'click', target: { ref } } });
    assert.equal(outcome.ok, false);
    assert.equal(replacement.clicks, 0);
    const fresh = await page.send({ type: 'OBSERVE' });
    assert.ok(fresh.pageMetadata.domRevision > old.pageMetadata.domRevision);
    assert.notEqual(replacement.dataset.captainRef, ref, 'replaced node gets a different cN ref');
    const again = await page.send({ type: 'EXECUTE', observationGuard: oldGuard, action: { type: 'click', target: { ref } } });
    assert.equal(again.ok, false);
    assert.equal(replacement.clicks, 0);
  } finally { page.dispose(); }
});

test('guard refuses missing, forged, and previous-observation identity in real extension runtime', async () => {
  const spec = await fixture('search'), page = syntheticPage(spec);
  try {
    const initial = await page.send({ type: 'OBSERVE' });
    const ref = page.nodes.get('searchButton').dataset.captainRef;
    const good = guard(initial);
    for (const observationGuard of [undefined, {}, { ...good, documentToken: 'f'.repeat(32) }, { ...good, domRevision: good.domRevision + 1 }, { ...good, geometryRevision: good.geometryRevision + 1 }, { ...good, observationId: 'stale-observation' }]) {
      const outcome = await page.send({ type: 'EXECUTE', observationGuard, action: { type: 'click', target: { ref } } });
      assert.equal(outcome.ok, false);
    }
    assert.equal(page.nodes.get('searchButton').clicks, 0);
    const fresh = await page.send({ type: 'OBSERVE' });
    const accepted = await page.send({ type: 'EXECUTE', observationGuard: guard(fresh), action: { type: 'click', target: { ref } } });
    assert.equal(accepted.ok, true, 'fresh, locally observed safe control is actionable');
    assert.equal(page.nodes.get('searchButton').clicks, 1);
    const replay = await page.send({ type: 'EXECUTE', observationGuard: guard(fresh), action: { type: 'click', target: { ref } } });
    assert.equal(replay.ok, false, 'execution consumes its observation guard');
    assert.equal(page.nodes.get('searchButton').clicks, 1, 'one-use guard cannot click twice');
  } finally { page.dispose(); }
});

test('geometry remains viewport CSS pixels and a geometry-only change invalidates previous guard', async () => {
  const spec = await fixture('search'), page = syntheticPage(spec, { viewport: [800, 600], dpr: 2.5 });
  try {
    const before = await page.send({ type: 'OBSERVE' });
    const field = before.elements.find(el => el.type === 'search');
    assert.deepEqual(plain(field.bbox), { x: 22, y: 58, width: 310, height: 38 });
    assert.equal(before.viewport.devicePixelRatio, 2.5);
    page.nodes.get('query')._box[1] += 70;
    page.emitMutation([{ type: 'attributes', attributeName: 'style', target: page.nodes.get('query') }]);
    const rejected = await page.send({ type: 'EXECUTE', observationGuard: guard(before), action: { type: 'click', target: { ref: field.ref } } });
    assert.equal(rejected.ok, false);
    const after = await page.send({ type: 'OBSERVE' });
    assert.equal(after.elements.find(el => el.type === 'search').bbox.y, 128);
    assert.ok(after.pageMetadata.geometryRevision >= before.pageMetadata.geometryRevision);
  } finally { page.dispose(); }
});

test('dynamic observer preserves stable live ref, invalidates changed semantics, and caches control traversal', async () => {
  const spec = await fixture('dynamic'), page = syntheticPage(spec);
  try {
    const first = await page.send({ type: 'OBSERVE' });
    const control = page.nodes.get('stable'), ref = control.dataset.captainRef;
    const selector = [...page.queries.keys()].find(pattern => pattern.includes('input:not') && pattern.includes('contenteditable'));
    assert.ok(selector, 'content script traverses the synthetic control selector');
    const scans = page.queries.get(selector);
    const unchanged = await page.send({ type: 'OBSERVE' });
    assert.equal(page.queries.get(selector), scans, 'repeat observation reuses control traversal while DOM is unchanged');
    assert.equal(unchanged.elements.find(el => el.ref === ref)?.name, first.elements.find(el => el.ref === ref)?.name);
    control.setAttribute('aria-label', 'Load updated records');
    page.emitMutation([{ type: 'attributes', attributeName: 'aria-label', target: control }]);
    const stale = await page.send({ type: 'EXECUTE', observationGuard: guard(unchanged), action: { type: 'click', target: { ref } } });
    assert.equal(stale.ok, false);
    assert.equal(control.clicks, 0);
    const updated = await page.send({ type: 'OBSERVE' });
    assert.equal(control.dataset.captainRef, ref, 'same live node keeps its cN ref');
    assert.match(updated.elements.find(el => el.ref === ref)?.name, /updated records/i);
    assert.ok(updated.pageMetadata.domRevision > first.pageMetadata.domRevision);
    assert.ok(page.queries.get(selector) > scans, 'mutation invalidates the control traversal cache');
  } finally { page.dispose(); }
});

test('scroll and zoom-like viewport resize update geometry lease without changing DOM identity', async () => {
  const spec = await fixture('search'), page = syntheticPage(spec, { dpr: 1.5 });
  try {
    const first = await page.send({ type: 'OBSERVE' });
    const oldGuard = guard(first), field = first.elements.find(el => el.type === 'search');
    page.nodes.get('query')._box[1] += 25;
    page.emitGlobal('scroll');
    const stale = await page.send({ type: 'EXECUTE', observationGuard: oldGuard, action: { type: 'click', target: { ref: field.ref } } });
    assert.equal(stale.ok, false);
    const next = await page.send({ type: 'OBSERVE' });
    assert.equal(next.pageMetadata.documentToken, first.pageMetadata.documentToken);
    assert.equal(next.pageMetadata.domRevision, first.pageMetadata.domRevision);
    assert.ok(next.pageMetadata.geometryRevision > first.pageMetadata.geometryRevision);
    assert.equal(next.elements.find(el => el.ref === field.ref)?.bbox.y, field.bbox.y + 25);
    page.sandbox.devicePixelRatio = 2;
    page.emitGlobal('resize');
    const resized = await page.send({ type: 'OBSERVE' });
    assert.equal(resized.viewport.devicePixelRatio, 2);
    assert.ok(resized.pageMetadata.geometryRevision > next.pageMetadata.geometryRevision);
  } finally { page.dispose(); }
});
