import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { createHash, webcrypto } from 'node:crypto';

const [serviceSource, contentSource, privacySource] = await Promise.all([
  readFile(new URL('../extension/service-worker.js', import.meta.url), 'utf8'),
  readFile(new URL('../extension/content-script.js', import.meta.url), 'utf8'),
  readFile(new URL('../extension/privacy/privacy-core.js', import.meta.url), 'utf8'),
]);
const MODEL_SHA = 'd7c687949526065ab6a192fdf993360045ce27b0fabf7c9fca5c2437b786b495';
const tab = () => ({ id: 7, windowId: 3, incognito: false, active: true, url: 'https://fixture.example/catalog' });
const observation = () => ({
  url: 'https://fixture.example/catalog', title: 'Public catalog', pageText: 'Public catalog', elements: [],
  redactionBoxes: [{ x: 10, y: 10, width: 20, height: 15, kind: 'RASTER_CONTENT' }],
  viewport: { width: 100, height: 50, devicePixelRatio: 2 },
  localTiming: {}, vision: {},
  pageMetadata: { documentToken: 'opaque-document-a', observationId: 'opaque-observation-a',
    domRevision: 4, geometryRevision: 3, domFingerprint: 'public-fingerprint' },
});
function jpeg(byte) {
  const image = Buffer.alloc(120, byte);
  image[0] = 0xff; image[1] = 0xd8; image[2] = 0xff;
  image[118] = 0xff; image[119] = 0xd9;
  return { dataUrl: `data:image/jpeg;base64,${image.toString('base64')}`,
    size: image.length, digest: createHash('sha256').update(image).digest('hex') };
}
const raw = jpeg(8), masked = jpeg(9);
function validVisual() {
  return { ok: true, screenshot: masked.dataUrl, visualPrivacy: {
    schema: 'captain.visual-privacy.v2', sanitized: true, rawScreenshotTransmitted: false, fullBlackout: false,
    redactionApplied: true, maskPolicy: 'opaque-raster-v1', coverageVerified: true, pixelMaskCount: 1,
    domBoxes: 1, faces: 0, faceModel: 'ultraface-rfb-320', modelSha256: MODEL_SHA,
    imageSha256: masked.digest, outputBytes: masked.size,
    input: { width: 200, height: 100 }, inferenceMs: 2, totalMs: 4,
  } };
}
function fixture() {
  const state = { tab: tab(), activeId: 7, snapshots: [observation(), observation(), observation()],
    captures: 0, workerCalls: 0, observations: 0, workerResult: validVisual(), requests: [],
    onCapture: null, onWorker: null, capturePanelHidden: false, panelRestores: 0,
    panelHideDenied: false };
  const sandbox = {
    URL, AbortController, performance, crypto: webcrypto, atob, setTimeout, clearTimeout,
    chrome: {
      runtime: { id: 'synthetic-extension', onMessage: { addListener() {} },
        sendMessage: async request => { state.workerCalls++; state.requests.push(request);
          state.onWorker?.(); return state.workerResult; } },
      tabs: {
        get: async () => ({ ...state.tab }),
        query: async () => [{ id: state.activeId, windowId: 3 }],
        captureVisibleTab: async () => { state.captures++; state.onCapture?.(); return raw.dataUrl; },
      },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(privacySource, sandbox, { filename: 'privacy-core.js' });
  vm.runInContext(serviceSource, sandbox, { filename: 'service-worker.js' });
  // Keep the real capture, lease and image verification functions; stub only
  // the unrelated focus and Chrome content-message transport.
  sandbox.focusTarget = async () => {};
  sandbox.send = async (_id, message) => {
    if (message.type === 'CAPTURE_PANEL') {
      if (message.mode === 'hide') {
        if (state.panelHideDenied) return { ok: false };
        state.capturePanelHidden = true;
        return { ok: true };
      }
      if (message.mode === 'restore') {
        state.capturePanelHidden = false; state.panelRestores++;
        return { ok: true };
      }
      return { ok: false };
    }
    assert.equal(message.type, 'OBSERVE');
    assert.equal(message.captureRequested, true);
    return structuredClone(state.snapshots[Math.min(state.observations++, state.snapshots.length - 1)]);
  };
  return { sandbox, state, run: () => sandbox.observe(tab(), { includeScreenshot: true }) };
}
const genericError = error => {
  assert.equal(error.message, 'Local visual privacy failed; screenshot withheld.');
  assert.doesNotMatch(error.message, /canary|data:image|worker|synthetic-secret/i);
  return true;
};

test('timed-out visual cleanup reloads only the exact normal-window controller, never a website', async () => {
  const h = fixture();
  let reloads = [];
  const trustedUrl = 'chrome-extension://synthetic-extension/popup.html?window=3';
  h.sandbox.chrome.runtime.getURL = path => `chrome-extension://synthetic-extension/${path}`;
  h.sandbox.chrome.tabs.query = async () => [
    { id: 7, windowId: 3, incognito: false, url: tab().url },
    { id: 8, windowId: 3, incognito: false, url: trustedUrl }
  ];
  h.sandbox.chrome.tabs.get = async id => ({ id, windowId: 3, incognito: false, url: trustedUrl });
  h.sandbox.chrome.tabs.reload = async id => reloads.push(id);
  assert.equal(await h.sandbox.disposeTimedOutVisualWorker(tab()), true);
  assert.deepEqual(reloads, [8]);
  reloads = [];
  h.sandbox.chrome.tabs.query = async () => [
    { id: 8, windowId: 4, incognito: false, url: trustedUrl },
    { id: 9, windowId: 3, incognito: true, url: trustedUrl }
  ];
  assert.equal(await h.sandbox.disposeTimedOutVisualWorker(tab()), false);
  assert.deepEqual(reloads, []);
});

test('Google sign-in receives the same local privacy scan and masked proof as other websites', async () => {
  const h = fixture();
  h.state.tab.url = 'https://accounts.google.com/';
  h.state.snapshots.forEach(snapshot => { snapshot.url = h.state.tab.url; });
  const result = await h.sandbox.observe(h.state.tab, { includeScreenshot: true });
  assert.equal(h.state.observations, 3);
  assert.equal(h.state.workerCalls, 1);
  assert.equal(result.screenshot, masked.dataUrl);
});

test('human challenges hand off locally without capturing or calling the visual worker', async () => {
  const h = fixture();
  h.state.snapshots[0].challenge = { detected: true, kind: 'captcha' };
  const result = await h.run();
  assert.equal(result.challenge.detected, true);
  assert.equal(result.screenshot, undefined);
  assert.equal(result.redactionBoxes, undefined);
  assert.equal(h.state.captures, 0);
  assert.equal(h.state.workerCalls, 0);
  assert.equal(result.vision.status, 'withheld-human-verification');
});

test('resume DOM check cannot replace the fresh full visual observation', () => {
  const resumed = serviceSource.slice(serviceSource.indexOf("phase: 'RESUMING'"), serviceSource.indexOf('const consentScope = privacyConsentScope(context)'));
  assert.match(resumed, /context = await observeStable\(tab, observationConfig\)/);
  assert.doesNotMatch(resumed, /context = handoff\.context/);
});

test('dynamic page recovery performs a fresh observation after a stale redaction lease', async () => {
  const h = fixture();
  let attempts = 0, waits = 0;
  h.sandbox.observe = async () => {
    if (++attempts === 1) throw Object.assign(new Error('withheld'), { captainVisualStage: 'redaction-lease' });
    return { screenshot: 'new-proof-only' };
  };
  h.sandbox.waitForPrivacyScanReady = async () => { waits++; };
  assert.equal((await h.sandbox.observeStable(tab(), {})).screenshot, 'new-proof-only');
  assert.equal(attempts, 2);
  assert.equal(waits, 1);
});

test('dynamic page retries are bounded and cannot follow a changed tab URL', async () => {
  const h = fixture();
  let attempts = 0;
  h.sandbox.observe = async () => { attempts++; throw Object.assign(new Error('withheld'), { captainVisualStage: 'capture-lease' }); };
  h.sandbox.waitForPrivacyScanReady = async () => {};
  await assert.rejects(h.sandbox.observeStable(tab(), {}));
  assert.equal(attempts, 3);
  attempts = 0;
  h.state.tab.url = 'https://fixture.example/replaced';
  await assert.rejects(h.sandbox.observeStable(tab(), {}));
  assert.equal(attempts, 1);
});

test('model and pixel-proof failures never qualify for dynamic-page recovery', async () => {
  const h = fixture();
  let attempts = 0;
  h.sandbox.observe = async () => { attempts++; throw Object.assign(new Error('withheld'), { captainVisualStage: 'worker-proof' }); };
  await assert.rejects(h.sandbox.observeStable(tab(), {}));
  assert.equal(attempts, 1);
});

test('valid v2 proof is checked against actual JPEG bytes before sanitized planner context', async () => {
  const h = fixture();
  const output = await h.run();
  assert.equal(h.state.captures, 1);
  assert.equal(h.state.capturePanelHidden, false);
  assert.equal(h.state.panelRestores, 1);
  assert.equal(h.state.workerCalls, 1);
  assert.equal(h.state.observations, 3);
  assert.equal(h.state.requests[0].screenshot, raw.dataUrl);
  assert.equal(h.state.requests[0].redactionBoxes[0].kind, 'RASTER_CONTENT');
  assert.equal(output.screenshot, masked.dataUrl);
  assert.equal(output.screenshotMetadata.sha256, masked.digest);
  assert.equal(output.visualPrivacy.backend, undefined);
  assert.equal(output.pageMetadata.sanitizedScreenshotFingerprint, masked.digest);
  assert.equal(output.redactionBoxes, undefined);
  assert.equal(h.sandbox.plannerContext(output).pageMetadata.documentToken, undefined);
  assert.doesNotMatch(JSON.stringify(h.sandbox.plannerContext(output)), new RegExp(raw.dataUrl.slice(30, 62)));
});

test('CAPTAIN-owned floating panel refusal prevents screenshot and raw-image worker dispatch', async () => {
  const h=fixture(); h.state.panelHideDenied=true;
  await assert.rejects(h.run(), genericError);
  assert.equal(h.state.captures,0);
  assert.equal(h.state.workerCalls,0);
  assert.equal(h.state.panelRestores,1);
});

test('only the active normal working tab can be captured', async () => {
  for (const change of [{ incognito: true }, { windowId: 8 }, { url: 'https://fixture.example/other' }]) {
    const h = fixture(); Object.assign(h.state.tab, change);
    await assert.rejects(h.run(), genericError);
    assert.equal(h.state.captures, 0);
    assert.equal(h.state.workerCalls, 0);
  }
  const h = fixture(); h.state.activeId = 9;
  await assert.rejects(h.run(), genericError);
  assert.equal(h.state.captures, 0);
});

test('a transient native screenshot failure uses one bounded debugger fallback and resets it for the next task', async () => {
  const h = fixture();
  let attachCalls = 0;
  let detachCalls = 0;
  h.sandbox.chrome.tabs.captureVisibleTab = async () => {
    h.state.captures++;
    throw new Error('image readback failed');
  };
  h.sandbox.chrome.debugger = {
    attach: async () => { attachCalls++; },
    sendCommand: async () => ({ data: raw.dataUrl.split(',')[1] }),
    detach: async () => { detachCalls++; },
  };
  const image = await h.sandbox.captureWorkingTab(tab());
  assert.equal(image, raw.dataUrl);
  assert.equal(h.state.captures, 2);
  assert.equal(attachCalls, 1);
  assert.equal(detachCalls, 1);
  assert.equal(vm.runInContext('preferDebuggerCapture', h.sandbox), false);
});

test('changing active tab immediately after capture withholds the raw image', async () => {
  const h = fixture(); h.state.onCapture = () => { h.state.activeId = 9; };
  await assert.rejects(h.run(), genericError);
  assert.equal(h.state.captures, 1);
  assert.equal(h.state.workerCalls, 0);
});

for (const [description, changed] of [
  ['document replacement', { pageMetadata: { ...observation().pageMetadata, documentToken: 'new-document' } }],
  ['DOM revision', { pageMetadata: { ...observation().pageMetadata, domRevision: 5 } }],
  ['geometry revision', { pageMetadata: { ...observation().pageMetadata, geometryRevision: 4 } }],
  ['page scroll position', { viewport: { ...observation().viewport, scrollY: 4 } }],
  ['viewport scale', { viewport: { ...observation().viewport, devicePixelRatio: 3 } }],
  ['privacy mask geometry', { redactionBoxes: [{ x: 10, y: 10, width: 21, height: 15, kind: 'RASTER_CONTENT' }] }],
]) {
  test(`${description} drift after capture blocks worker dispatch`, async () => {
    const h = fixture(); h.state.snapshots[1] = { ...observation(), ...changed };
    await assert.rejects(h.run(), genericError);
    assert.equal(h.state.workerCalls, 0);
  });
}

test('a post-capture sensitive box wholly inside the captured mask keeps the original proof', async () => {
  const h = fixture();
  const contained = observation();
  contained.redactionBoxes = [{ x: 12, y: 12, width: 10, height: 10, kind: 'EMAIL' }];
  h.state.snapshots[1] = contained;
  const result = await h.run();
  assert.equal(h.state.captures, 1);
  assert.equal(h.state.workerCalls, 1);
  assert.equal(h.state.observations, 3);
  // The worker uses the broader captured rectangle, never the later shrink.
  assert.deepEqual(h.state.requests[0].redactionBoxes, observation().redactionBoxes);
  assert.equal(result.screenshot, masked.dataUrl);
});

test('rolling local mask coverage tolerates unrelated DOM churn only when every later protected box is covered', async () => {
  const h = fixture();
  const later = observation();
  later.pageMetadata.domRevision = 5;
  later.redactionBoxes = [
    ...observation().redactionBoxes,
    { x: 50, y: 12, width: 16, height: 12, kind: 'EMAIL' },
  ];
  const afterCapture = structuredClone(later); afterCapture.pageMetadata.domRevision = 6; afterCapture.pageMetadata.geometryRevision = 4;
  const afterRedaction = structuredClone(later); afterRedaction.pageMetadata.domRevision = 7; afterRedaction.pageMetadata.geometryRevision = 5;
  h.state.snapshots = [observation(), later, afterCapture, afterRedaction];
  const result = await h.sandbox.observe(tab(), { includeScreenshot: true, rollingCaptureSamples: 1 });
  assert.equal(h.state.captures, 1);
  assert.equal(h.state.workerCalls, 1);
  assert.equal(h.state.observations, 4);
  assert.equal(JSON.parse(JSON.stringify(h.state.requests[0].redactionBoxes)).length, 2);
  assert.equal(result.screenshot, masked.dataUrl);
});

test('rolling local mask coverage still withholds a newly exposed area outside the union', async () => {
  const h = fixture();
  const sampled = observation(); sampled.pageMetadata.domRevision = 5;
  sampled.redactionBoxes = [...observation().redactionBoxes,
    { x: 50, y: 12, width: 16, height: 12, kind: 'EMAIL' }];
  const exposed = observation(); exposed.pageMetadata.domRevision = 6;
  exposed.redactionBoxes = [{ x: 75, y: 12, width: 16, height: 12, kind: 'PHONE' }];
  h.state.snapshots = [observation(), sampled, exposed];
  await assert.rejects(h.sandbox.observe(tab(), { includeScreenshot: true, rollingCaptureSamples: 1 }), genericError);
  assert.equal(h.state.captures, 1);
  assert.equal(h.state.workerCalls, 0);
});

test('document drift during local vision also withholds the returned image', async () => {
  const h = fixture(); h.state.snapshots[2].pageMetadata.domRevision++;
  await assert.rejects(h.run(), genericError);
  assert.equal(h.state.workerCalls, 1);
});

test('post-redaction mask drift discards the old proof and repeats the entire fresh capture once', async () => {
  const h = fixture();
  const changed = observation(); changed.redactionBoxes[0].width = 21;
  h.state.snapshots = [observation(), observation(), changed, changed, changed, changed];
  const result = await h.run();
  assert.equal(h.state.captures, 2, 'A changed mask must trigger a NEW capture.');
  assert.equal(h.state.workerCalls, 2, 'The old visual proof cannot authorize the new observation.');
  assert.equal(h.state.observations, 6, 'Both attempts require all three independent observations.');
  assert.equal(h.state.requests[0].redactionBoxes[0].width, 20);
  assert.equal(h.state.requests[1].redactionBoxes[0].width, 21);
  assert.equal(result.screenshot, masked.dataUrl);
  assert.equal(result.screenshotMetadata.sha256, masked.digest);
  assert.equal(result.redactionBoxes, undefined);
});

test('a post-redaction sensitive box wholly inside the captured mask does not recapture', async () => {
  const h = fixture();
  const contained = observation();
  contained.redactionBoxes = [{ x: 12, y: 12, width: 10, height: 10, kind: 'EMAIL' }];
  h.state.snapshots[2] = contained;
  const result = await h.run();
  assert.equal(h.state.captures, 1);
  assert.equal(h.state.workerCalls, 1);
  assert.equal(h.state.observations, 3);
  assert.deepEqual(h.state.requests[0].redactionBoxes, observation().redactionBoxes);
  assert.equal(result.screenshot, masked.dataUrl);
});

test('repeated post-redaction mask drift fails closed after only one fresh recapture', async () => {
  const h = fixture();
  const second = observation(); second.redactionBoxes[0].width = 21;
  const third = observation(); third.redactionBoxes[0].width = 22;
  h.state.snapshots = [observation(), observation(), second, second, second, third];
  await assert.rejects(h.run(), genericError);
  assert.equal(h.state.captures, 2);
  assert.equal(h.state.workerCalls, 2);
  assert.equal(h.state.observations, 6);
});

test('post-redaction changed document identity never qualifies for mask-drift recapture', async () => {
  const h = fixture();
  h.state.snapshots[2].pageMetadata.documentToken = 'different-document';
  h.state.snapshots[2].redactionBoxes[0].width = 21;
  await assert.rejects(h.run(), genericError);
  assert.equal(h.state.captures, 1);
  assert.equal(h.state.workerCalls, 1);
  assert.equal(h.state.observations, 3);
});

test('unknown, missing or malformed viewport and privacy boxes fail before capture', async () => {
  const invalid = [
    { viewport: { width: 0, height: 50, devicePixelRatio: 2 } },
    { viewport: { width: 100, height: 50, devicePixelRatio: Infinity } },
    { redactionBoxes: undefined },
    { redactionBoxes: [{ x: NaN, y: 0, width: 20, height: 10, kind: 'EMAIL' }] },
    { redactionBoxes: [{ x: 1, y: 1, width: 10, height: 10, kind: 'UNKNOWN CANARY' }] },
    { redactionBoxes: Array.from({ length: 501 }, () => ({ x: 1, y: 1, width: 10, height: 10, kind: 'RASTER_CONTENT' })) },
  ];
  for (const change of invalid) {
    const h = fixture(); Object.assign(h.state.snapshots[0], change);
    await assert.rejects(h.run(), genericError);
    assert.equal(h.state.captures, 0);
    assert.equal(h.state.workerCalls, 0);
  }
});

test('failed worker error never reaches task error, state or planner', async () => {
  const h = fixture(); h.state.workerResult = { ok: false, error: 'synthetic-secret-canary in failed worker' };
  await assert.rejects(h.run(), genericError);
  assert.equal(h.state.workerCalls, 1);
});

test('whole-frame proof withholds image egress instead of sending a black page', async () => {
  const h = fixture(); h.state.workerResult.visualPrivacy.domBoxes = 0;
  h.state.workerResult.visualPrivacy.pixelMaskCount = 1;
  h.state.workerResult.visualPrivacy.fullBlackout = true;
  const context = await h.run();
  assert.equal(context.visualPrivacy, undefined);
  assert.equal(context.screenshot, undefined);
  assert.equal(context.screenshotMetadata, undefined);
  assert.equal(context.vision.status, 'image-withheld');
});

for (const [description, alter] of [
  ['legacy v1 proof', result => { result.visualPrivacy.schema = 'captain.visual-privacy.v1'; }],
  ['missing opaque raster mask policy', result => { delete result.visualPrivacy.maskPolicy; }],
  ['unverified coverage', result => { result.visualPrivacy.coverageVerified = false; }],
  ['zero pixel masks', result => { result.visualPrivacy.pixelMaskCount = 0; }],
  ['missing model integrity', result => { result.visualPrivacy.modelSha256 = '0'.repeat(64); }],
  ['bad proof digest', result => { result.visualPrivacy.imageSha256 = '0'.repeat(64); }],
  ['wrong byte count', result => { result.visualPrivacy.outputBytes++; }],
  ['raw screenshot echo', result => { result.screenshot = raw.dataUrl; }],
  ['no masked JPEG', result => { result.screenshot = 'data:image/png;base64,AAAA'; }],
]) {
  test(`worker ${description} cannot enter context`, async () => {
    const h = fixture(); h.state.workerResult = validVisual(); alter(h.state.workerResult);
    await assert.rejects(h.run(), genericError);
  });
}

test('planner image injection cannot be accepted or persisted as task history', () => {
  const h = fixture();
  assert.doesNotThrow(() => h.sandbox.assertNoPrivatePlannerText({ vision: { status: 'visual-disabled' } }));
  assert.doesNotThrow(() => h.sandbox.assertNoPrivatePlannerText({ vision: { status: 'sanitized', redactionBoxes: 5 } }));
  for (const bad of [raw.dataUrl, [], [{ x: 1, y: 1 }], -1, 501, 2.5, NaN, Infinity]) {
    assert.throws(() => h.sandbox.assertNoPrivatePlannerText({ vision: { redactionBoxes: bad } }), /image payload was withheld/i);
  }
  assert.throws(() => h.sandbox.assertNoPrivatePlannerText({ action: { redactionBoxes: 5 } }), /image payload was withheld/i);
  assert.throws(() => h.sandbox.assertNoPrivatePlannerText({ vision: { screenshot: 'disabled-until-complete-visual-redaction' } }), /image payload was withheld/i);
  assert.throws(() => h.sandbox.assertNoPrivatePlannerText({ action: { type: 'finish', screenshot: raw.dataUrl } }), /image payload was withheld/i);
  assert.throws(() => h.sandbox.assertNoPrivatePlannerText({ vision: { screenshot: 'data:image/jpeg;base64,AAAA' } }), /image payload was withheld/i);
  assert.throws(() => h.sandbox.assertNoPrivatePlannerText({ action: { type: 'finish', message: raw.dataUrl } }), /image payload was withheld/i);
  assert.throws(() => h.sandbox.assertNoPrivatePlannerText({ action: { type: 'finish', visualPrivacy: validVisual().visualPrivacy } }), /image payload was withheld/i);
});

test('obsolete page-local screenshot sanitizer is absent from all content-script message paths', () => {
  assert.doesNotMatch(contentSource, /SANITIZE_SCREENSHOT|sanitizeScreenshot\(/);
  assert.match(contentSource, /captureRequested === true/);
  assert.match(contentSource, /if \(strict\) throw new Error\(PRIVATE_OBSERVATION_ERROR\)/);
});

function syntheticPrivateTextRange(mode, styledCount = 0, options = {}) {
  let receiver, visited = false;
  const email = 'synthetic-private@example.test';
  const rect = { x: 15, y: 20, left: 15, top: 20, width: 200, height: 25, right: 215, bottom: 45 };
  const doc = {
    title: 'Public catalog', documentElement: null, readyState: 'complete', visibilityState: 'visible', images: [],
    addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
    querySelector() { return null; },
    querySelectorAll(selector) { return selector === 'body *,*' ? Array(styledCount).fill({ownerDocument:doc,
      getBoundingClientRect: () => ({x:5,y:5,left:5,top:5,right:15,bottom:15,width:10,height:10}), closest: () => null}) : []; },
    createTreeWalker() { visited = false; return { nextNode() { if (visited) return null; visited = true; return node; } }; },
  };
  const parent = { tagName: options.parentTag || 'DIV', ownerDocument: doc,
    getBoundingClientRect: () => options.parentRect || rect, closest: () => null };
  const node = { nodeValue: options.text || `Contact ${email}`, parentElement: parent };
  doc.body = { innerText: node.nodeValue, ownerDocument: doc };
  class Range {
    setStart() { if (mode === 'throw') throw new Error(`Range failed: ${email}`); }
    setEnd() {}
    getClientRects() { return mode === 'empty' ? [] : [options.rangeRect || rect]; }
  }
  class MutationObserver { observe() {} takeRecords() { return []; } disconnect() {} }
  const sandbox = {
    URL, Date, Event: class { constructor(type) { this.type = type; } },
    crypto: webcrypto, performance, MutationObserver, NodeFilter: { SHOW_TEXT: 4 },
    Range, setTimeout, clearTimeout, setInterval, clearInterval,
    innerWidth: 100, innerHeight: 80, devicePixelRatio: 2,
    getComputedStyle: () => ({ visibility: 'visible', display: 'block', opacity: '1', backgroundImage: 'none' }),
    addEventListener() {}, removeEventListener() {}, location: {
      href: 'https://fixture.example/catalog', origin: 'https://fixture.example', hostname: 'fixture.example', pathname: '/catalog',
    },
    document: doc,
    chrome: { runtime: { id: 'synthetic-extension', onMessage: { addListener(fn) { receiver = fn; }, removeListener() {} } } },
  };
  sandbox.window = sandbox; doc.defaultView = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(privacySource, sandbox);
  vm.runInContext(contentSource, sandbox);
  return { email, send: message => new Promise(resolve => receiver(message, {}, resolve)) };
}

test('visible private Range failure blocks the whole capture observation with generic error', async () => {
  const page = syntheticPrivateTextRange('throw');
  const result = await page.send({ type: 'OBSERVE', captureRequested: true });
  assert.deepEqual(Object.keys(result), ['error']);
  assert.doesNotMatch(result.error, /synthetic-private|range failed/i);
  assert.equal(result.pageText, undefined);
  assert.equal(result.redactionBoxes, undefined);
});

test('visible private text with empty Range rectangles receives conservative parent mask', async () => {
  const page = syntheticPrivateTextRange('empty');
  const result = await page.send({ type: 'OBSERVE', captureRequested: true });
  assert.equal(result.error, undefined);
  assert.equal(result.redactionBoxes[0].kind, 'EMAIL');
  assert.equal(result.redactionBoxes[0].x, 15);
  assert.equal(result.redactionBoxes[0].width, 200);
  assert.doesNotMatch(JSON.stringify(result), /synthetic-private@example\.test/);
});

test('strict capture has a conservative bounded semantic address-block mask contract', () => {
  assert.match(contentSource, /strict && finding\.kind === 'ADDRESS'/);
  assert.match(contentSource, /\^\(\?:P\|LI\|DD\|ADDRESS\)/);
  assert.match(contentSource, /box\.width \* box\.height > innerWidth \* innerHeight \* 0\.25/);
  assert.match(contentSource, /regions\.push\(\{ x: box\.x, y: box\.y, width: box\.width, height: box\.height, kind: finding\.kind \}\)/);
});

test('public-sized styled DOM is fully inspected before releasing capture observation', async () => {
  const page = syntheticPrivateTextRange('empty', 1726);
  const result = await page.send({ type: 'OBSERVE', captureRequested: true });
  assert.equal(result.error, undefined);
  assert.equal(result.redactionBoxes[0].kind, 'EMAIL');
  assert.doesNotMatch(JSON.stringify(result), /synthetic-private@example\.test/);
});

test('styled DOM above the new bounded budget still fails capture closed', async () => {
  const page = syntheticPrivateTextRange('empty', 2501);
  const result = await page.send({ type: 'OBSERVE', captureRequested: true });
  assert.deepEqual(Object.keys(result), ['error']);
  assert.equal(result.redactionBoxes, undefined);
  assert.equal(result.pageText, undefined);
});
