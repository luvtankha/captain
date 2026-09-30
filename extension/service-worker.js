const CAPTAIN_BUILD = '0.5.0';
function enforceActionPrivacy(action, elements = []) {
  const target = action?.target?.ref ? elements.find(element => element.ref === action.target.ref) : null;
  if (['type', 'select', 'press', 'submit'].includes(action?.type) && target?.sensitive) throw new Error('Remote control of a sensitive field was blocked. Use local secure input.');
  if (action?.type === 'request_local_input') {
    if (!target?.sensitive) throw new Error('Local secure input requires an observed sensitive field.');
    if (!['password', 'otp', 'pin', 'cvv', 'card', 'token', 'api-key', 'secret', 'security-answer'].includes(action.inputType)) throw new Error('Unsupported local secure input type.');
    if (['value', 'text', 'secret', 'data'].some(key => Object.hasOwn(action, key))) throw new Error('A local secure-input action must not contain a value.');
  }
  return target;
}
const DEFAULTS = { serverUrl: 'http://127.0.0.1:4317', maxSteps: 12, includeScreenshot: true };
const ROLLING_CAPTURE_SAMPLES = 3;
// A scroll or history action can reveal a different part of a page. Keep the
// same local screenshot/redaction proof for every ordinary command so newly
// visible sensitive information is marked before the next plan or action.
// The separately bounded Amazon product fast path remains DOM-only because it
// has its own identity-checked product extractor.
function visualObservationEnabled(_task, config, amazonFastPath = false) {
  return !!config.includeScreenshot && !amazonFastPath;
}
// The strict outbound contract lives in the local CAPTAIN companion. Never
// let a synced setting turn an extension request into a direct remote upload.
// Require an exact numeric loopback host and a dedicated TCP port; reject
// credentials, proxy paths, fragments, queries and non-HTTP schemes.
function normalizeLoopbackServerUrl(value) {
  const error = () => new Error('CAPTAIN planner must use a local 127.0.0.1 HTTP server with an explicit port.');
  if (typeof value !== 'string' || value.length > 128 || /[\s\\]/.test(value)) throw error();
  let parsed;
  try { parsed = new URL(value); } catch { throw error(); }
  const port = Number(parsed.port);
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' ||
      parsed.username || parsed.password || parsed.search || parsed.hash ||
      parsed.pathname !== '/' || !Number.isSafeInteger(port) || port < 1 || port > 65535) throw error();
  return `http://127.0.0.1:${port}`;
}
let running = false;
let localPreviewBusy = false;
let taskAbort;
let preferDebuggerCapture = false;
let humanHandoff = null;
let privacyApproval = null;
let observationSequence = 0;
const SENSITIVE_ACCESS_REQUIRED_MESSAGE = 'the site does not allow entry without information access please tell me what to do further ?';
const BOUND_TARGET_ACTIONS = new Set(['click', 'hover', 'type', 'press', 'select', 'submit', 'request_local_input']);
const VISUAL_CAPTURE_ERROR = 'Local visual privacy failed; screenshot withheld.';
const VISUAL_MODEL_SHA256 = 'd7c687949526065ab6a192fdf993360045ce27b0fabf7c9fca5c2437b786b495';
// These page-local lease markers are never model context. In particular an
// identical DOM fingerprint is not proof of an identical document or control.
function perceptionLease(context) {
  const metadata = context?.pageMetadata || {};
  return {
    documentToken: metadata.documentToken,
    domRevision: metadata.domRevision,
    geometryRevision: metadata.geometryRevision,
    observationId: metadata.observationId,
  };
}
function localUISnapshot(context) {
  const lease = perceptionLease(context);
  // Explicit local-only projection: no OCR words, DOM names, field values,
  // labels, private tokens, element signatures or model-only cN references.
  return { lease, controls: (context.elements || []).slice(0, 250).map(element => ({
    ref: element.ref, box: element.bbox, source: element.source,
    visible: element.visible, enabled: element.enabled,
    sensitive: element.sensitive, lease
  })) };
}
function privacyConsentRequired(context, piiDetected) {
  // Count either a textual match or an image/DOM mask. This keeps the consent
  // gate closed even when an uncertain visual region cannot be named safely.
  return Number(piiDetected) > 0 || Number(context?.vision?.redactionBoxes) > 0 ||
    Number(context?.visualPrivacy?.pixelMaskCount) > 0;
}
function privacyConsentScope(context) {
  const counts = Object.entries(context?.piiCounts || {}).sort(([a], [b]) => a.localeCompare(b));
  const protectedControls = (context?.elements || []).filter(element => element.sensitive)
    .map(element => element.ref).sort();
  return JSON.stringify([context?.url || '', context?.pageMetadata?.documentToken || '', counts,
    protectedControls, context?.vision?.redactionBoxes || 0]);
}
function actionNeedsSensitiveAccess(action, elements = []) {
  if (action?.type === 'request_local_input') return true;
  const target = action?.target?.ref ? elements.find(element => element.ref === action.target.ref) : null;
  return !!target?.sensitive && ['type', 'select', 'press', 'submit'].includes(action?.type);
}
function completePerceptionLease(lease) {
  return typeof lease.documentToken === 'string' && lease.documentToken.length > 0 &&
    Number.isSafeInteger(lease.domRevision) && lease.domRevision >= 0 &&
    Number.isSafeInteger(lease.geometryRevision) && lease.geometryRevision >= 0 &&
    typeof lease.observationId === 'string' && lease.observationId.length > 0;
}
function completeVisualObservation(context) {
  const viewport = context?.viewport;
  if (!context || context.error || !completePerceptionLease(perceptionLease(context)) ||
    !viewport || !Number.isFinite(viewport.width) || viewport.width <= 0 || viewport.width > 16384 ||
    !Number.isFinite(viewport.height) || viewport.height <= 0 || viewport.height > 16384 ||
    !Number.isFinite(viewport.devicePixelRatio) || viewport.devicePixelRatio <= 0 || viewport.devicePixelRatio > 8 ||
    !Array.isArray(context.redactionBoxes) || context.redactionBoxes.length > 500) return false;
  return context.redactionBoxes.every(box => box && ['x', 'y', 'width', 'height'].every(key =>
    Number.isFinite(box[key]) && Math.abs(box[key]) <= 16384) && box.width > 0 && box.height > 0 &&
    typeof box.kind === 'string' && /^[A-Z][A-Z0-9_]{0,39}$/.test(box.kind));
}

async function companionAuthToken() {
  // storage.local is visible to content scripts by default. Authentication
  // belongs in storage.session (trusted extension contexts only) and must be
  // provisioned again by the local launcher after an extension/browser restart.
  const value = (await chrome.storage.session.get({ captainCompanionToken: '' })).captainCompanionToken;
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error('CAPTAIN companion authentication is unavailable. Run START-CAPTAIN.cmd again.');
  }
  return value;
}
function viewportMetric(viewport, key, fallback = 0) {
  return Number.isFinite(viewport?.[key]) ? viewport[key] : fallback;
}
function sameVisualObservationExceptBoxes(first, next, { allowDomRevisionDrift = false, allowGeometryRevisionDrift = false } = {}) {
  if (!completeVisualObservation(first) || !completeVisualObservation(next)) return false;
  const a = perceptionLease(first), b = perceptionLease(next);
  return a.documentToken === b.documentToken && (allowDomRevisionDrift || a.domRevision === b.domRevision) &&
    (allowGeometryRevisionDrift || a.geometryRevision === b.geometryRevision) && first.url === next.url &&
    first.viewport.width === next.viewport.width && first.viewport.height === next.viewport.height &&
    first.viewport.devicePixelRatio === next.viewport.devicePixelRatio &&
    Math.round(viewportMetric(first.viewport, 'scrollX')) === Math.round(viewportMetric(next.viewport, 'scrollX')) &&
    Math.round(viewportMetric(first.viewport, 'scrollY')) === Math.round(viewportMetric(next.viewport, 'scrollY')) &&
    Math.round(viewportMetric(first.viewport, 'visualOffsetX')) === Math.round(viewportMetric(next.viewport, 'visualOffsetX')) &&
    Math.round(viewportMetric(first.viewport, 'visualOffsetY')) === Math.round(viewportMetric(next.viewport, 'visualOffsetY')) &&
    viewportMetric(first.viewport, 'visualScale', 1) === viewportMetric(next.viewport, 'visualScale', 1);
}
function sameVisualObservation(first, next) {
  return sameVisualObservationExceptBoxes(first, next) &&
    JSON.stringify(first.redactionBoxes) === JSON.stringify(next.redactionBoxes);
}
// A capture proof remains valid when a later observation's every sensitive
// rectangle is wholly contained in one of the rectangles painted into that
// capture. This is deliberately stricter than using painter margins or overlap:
// a newly exposed edge, new box, changed lease, viewport, document or URL never
// qualifies. It handles harmless DOM de-duplication/shrink/reordering without
// re-sending the raw screenshot or throwing away an already safe JPEG proof.
function visualObservationCoveredByCapture(captured, latest, options) {
  if (!sameVisualObservationExceptBoxes(captured, latest, options)) return false;
  return latest.redactionBoxes.every(next => captured.redactionBoxes.some(prior =>
    next.x >= prior.x && next.y >= prior.y &&
    next.x + next.width <= prior.x + prior.width &&
    next.y + next.height <= prior.y + prior.height));
}
function visualLeaseReason(captured, latest, { allowDomRevisionDrift = false, allowGeometryRevisionDrift = false } = {}) {
  if (!completeVisualObservation(captured) || !completeVisualObservation(latest)) return 'invalid-observation';
  const a = perceptionLease(captured), b = perceptionLease(latest);
  if (a.documentToken !== b.documentToken) return 'document';
  if (!allowDomRevisionDrift && a.domRevision !== b.domRevision) return 'dom-revision';
  if (!allowGeometryRevisionDrift && a.geometryRevision !== b.geometryRevision) {
    const cause = latest?.pageMetadata?.geometryCause;
    return ['page-scroll', 'window-resize', 'viewport-resize', 'viewport-scroll'].includes(cause) ? `geometry-${cause}` : 'geometry-revision';
  }
  if (captured.url !== latest.url) return 'url';
  if (captured.viewport.width !== latest.viewport.width || captured.viewport.height !== latest.viewport.height ||
      captured.viewport.devicePixelRatio !== latest.viewport.devicePixelRatio) return 'viewport';
  if (Math.round(viewportMetric(captured.viewport, 'scrollX')) !== Math.round(viewportMetric(latest.viewport, 'scrollX')) ||
      Math.round(viewportMetric(captured.viewport, 'scrollY')) !== Math.round(viewportMetric(latest.viewport, 'scrollY')) ||
      Math.round(viewportMetric(captured.viewport, 'visualOffsetX')) !== Math.round(viewportMetric(latest.viewport, 'visualOffsetX')) ||
      Math.round(viewportMetric(captured.viewport, 'visualOffsetY')) !== Math.round(viewportMetric(latest.viewport, 'visualOffsetY')) ||
      viewportMetric(captured.viewport, 'visualScale', 1) !== viewportMetric(latest.viewport, 'visualScale', 1)) return 'scroll-position';
  return 'uncovered-protected-region';
}
function uniqueCaptureBoxes(groups) {
  const boxes = [], seen = new Set();
  for (const group of groups) for (const box of group || []) {
    const key = `${box.x}|${box.y}|${box.width}|${box.height}|${box.kind}`;
    if (!seen.has(key)) { seen.add(key); boxes.push(box); }
  }
  return boxes;
}
// A short rolling window turns a page's *known* changing sensitive regions
// into a union of opaque masks.  It only ever adds coverage.  The post-capture
// proof still rejects a new document, URL, viewport/scroll movement, malformed
// observation or any later protected area outside that union.  DOM revision
// drift alone is tolerated only for this rolling union because unrelated ads
// and hydration updates are otherwise able to starve a safe screenshot.
async function collectRollingCaptureCoverage(tab, context, samples) {
  const total = Math.max(0, Math.min(4, Number.isSafeInteger(samples) ? samples : 0));
  if (!total) return { context, rolling: false };
  let latest = context, groups = [context.redactionBoxes], collected = 0;
  for (let index = 0; index < total; index++) {
    checkpoint();
    await new Promise(resolve => setTimeout(resolve, 250));
    let next;
    try { next = await send(tab.id, { type: 'OBSERVE', captureRequested: true }, 1); }
    catch { break; }
    if (!sameVisualObservationExceptBoxes(context, next, { allowDomRevisionDrift: true, allowGeometryRevisionDrift: true })) break;
    groups.push(next.redactionBoxes);
    if (uniqueCaptureBoxes(groups).length > 500) break;
    latest = next;
    collected++;
  }
  if (!collected) return { context, rolling: false };
  const boxes = uniqueCaptureBoxes(groups);
  if (boxes.length > 500) throw new Error(VISUAL_CAPTURE_ERROR);
  return { context: { ...latest, redactionBoxes: boxes }, rolling: collected > 0 };
}
async function assertCaptureTab(tab) {
  const current = await chrome.tabs.get(tab.id);
  const [active] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
  if (!current || current.incognito || current.id !== tab.id || current.windowId !== tab.windowId ||
    current.url !== tab.url || current.pendingUrl || active?.id !== tab.id) throw new Error(VISUAL_CAPTURE_ERROR);
}
let creatingPrivateVisionHost;
async function ensurePrivateVisionHost() {
  // Firefox has no Chrome offscreen document API: retain the existing popup
  // fallback there. A Chrome host failure, however, MUST fail closed rather
  // than silently returning to the throttled page or transmitting raw pixels.
  if (!chrome.offscreen?.createDocument || !chrome.runtime?.getContexts) return false;
  const url = chrome.runtime.getURL('offscreen.html');
  const filter = incognito => ({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [url], incognito });
  const privateHosts = await chrome.runtime.getContexts(filter(true));
  if (privateHosts.length) throw new Error(VISUAL_CAPTURE_ERROR);
  let normalHosts = await chrome.runtime.getContexts(filter(false));
  if (normalHosts.length === 1) return true;
  if (normalHosts.length !== 0) throw new Error(VISUAL_CAPTURE_ERROR);
  if (!creatingPrivateVisionHost) {
    creatingPrivateVisionHost = chrome.offscreen.createDocument({
      url: 'offscreen.html', reasons: ['WORKERS', 'BLOBS'],
      justification: 'Run extension-only visual redaction without a throttled popup tab.'
    }).finally(() => { creatingPrivateVisionHost = null; });
  }
  await creatingPrivateVisionHost;
  normalHosts = await chrome.runtime.getContexts(filter(false));
  if (normalHosts.length !== 1 || (await chrome.runtime.getContexts(filter(true))).length)
    throw new Error(VISUAL_CAPTURE_ERROR);
  return true;
}
// When a nested local OCR/WASM worker stops responding, the enclosing popup
// timer may itself be throttled. The service worker's independent deadline
// must also dispose of that worker. Reload ONLY this task window's exact,
// privately bound CAPTAIN controller; do not navigate or reload the website.
// Never retry the failed screenshot or browser action after this cleanup.
async function disposeTimedOutVisualWorker(tab) {
  if (!chrome.runtime?.id || !Number.isSafeInteger(tab?.windowId)) return false;
  try {
    if (chrome.offscreen?.closeDocument && chrome.runtime?.getContexts) {
      const url = chrome.runtime.getURL('offscreen.html');
      const privateHosts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'],
        documentUrls: [url], incognito: false });
      if (privateHosts.length !== 1) return false;
      await chrome.offscreen.closeDocument();
      return true;
    }
    const controllerUrl = chrome.runtime.getURL(`popup.html?window=${tab.windowId}`);
    const tabs = await chrome.tabs.query({ windowId: tab.windowId });
    const matches = tabs.filter(candidate => candidate.incognito === false &&
      candidate.windowId === tab.windowId && candidate.id !== tab.id &&
      candidate.url === controllerUrl);
    if (matches.length !== 1) return false;
    const current = await chrome.tabs.get(matches[0].id);
    if (current.incognito || current.windowId !== tab.windowId || current.url !== controllerUrl)
      return false;
    await chrome.tabs.reload(current.id);
    return true;
  } catch { return false; }
}
async function verifyVisualResult(visual, rawScreenshot) {
  const proof = visual?.visualPrivacy, image = visual?.screenshot;
  if (visual?.ok !== true || typeof image !== 'string' || image === rawScreenshot ||
    !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(image) ||
    proof?.schema !== 'captain.visual-privacy.v2' || proof.sanitized !== true ||
    proof.rawScreenshotTransmitted !== false || proof.redactionApplied !== true ||
    proof.maskPolicy !== 'opaque-raster-v1' || proof.coverageVerified !== true ||
    proof.faceModel !== 'ultraface-rfb-320' || proof.modelSha256 !== VISUAL_MODEL_SHA256 ||
    !/^[0-9a-f]{64}$/.test(proof.imageSha256 || '') ||
    !Number.isSafeInteger(proof.pixelMaskCount) || proof.pixelMaskCount < 1 || proof.pixelMaskCount > 531 ||
    !Number.isSafeInteger(proof.domBoxes) || proof.domBoxes < 0 || proof.domBoxes > 500 ||
    !Number.isSafeInteger(proof.faces) || proof.faces < 0 || proof.faces > 30 ||
    !Number.isSafeInteger(proof.inferenceMs) || proof.inferenceMs < 0 ||
    !Number.isSafeInteger(proof.totalMs) || proof.totalMs < 0 ||
    !Number.isSafeInteger(proof.outputBytes) || proof.outputBytes < 100 || proof.outputBytes > 2_500_000 ||
    !Number.isSafeInteger(proof.input?.width) || !Number.isSafeInteger(proof.input?.height) ||
    proof.input.width <= 0 || proof.input.height <= 0 || proof.input.width * proof.input.height > 12_000_000) throw new Error(VISUAL_CAPTURE_ERROR);
  let bytes;
  try {
    const binary = atob(image.slice('data:image/jpeg;base64,'.length));
    bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  } catch { throw new Error(VISUAL_CAPTURE_ERROR); }
  if (bytes.length !== proof.outputBytes || bytes[0] !== 0xff || bytes[1] !== 0xd8 ||
    bytes[2] !== 0xff || bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9 ||
    !globalThis.crypto?.subtle?.digest) throw new Error(VISUAL_CAPTURE_ERROR);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hex = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  if (hex !== proof.imageSha256) throw new Error(VISUAL_CAPTURE_ERROR);
  const visualPrivacy = Object.fromEntries([
    'schema', 'sanitized', 'rawScreenshotTransmitted', 'redactionApplied',
    'domBoxes', 'faces', 'inferenceMs', 'totalMs', 'outputBytes',
    'faceModel', 'modelSha256', 'imageSha256', 'maskPolicy',
    'coverageVerified', 'pixelMaskCount', 'input',
  ].map(key => [key, proof[key]]));
  // An older worker without this usability signal cannot establish that any
  // visual evidence survived. This does not weaken the pixel privacy proof.
  visualPrivacy.fullBlackout = proof.fullBlackout !== false;
  return { screenshot: image, visualPrivacy };
}
function plannerContext(context) {
  // Explicit projection: all browser-local identity and future metadata remain
  // local unless deliberately reviewed and added to the outbound schema.
  const pageMetadata = Object.fromEntries([
    'domFingerprint', 'visibleTextHash', 'elementCount', 'meaningfulContent',
    'capturedAt', 'sanitizedScreenshotFingerprint',
  ].filter(key => Object.hasOwn(context.pageMetadata || {}, key))
    .map(key => [key, context.pageMetadata[key]]));
  // Scroll offsets are needed only to bind a local screenshot to its viewport.
  // Preserve the public dimensions the planner schema understands, but never
  // transmit those local navigation coordinates or future viewport metadata.
  const viewport = context.viewport && {
    width: context.viewport.width,
    height: context.viewport.height,
    devicePixelRatio: context.viewport.devicePixelRatio,
  };
  return { ...context, ...(viewport ? { viewport } : {}), pageMetadata };
}
// Server processing times are trusted operational hints for THIS step, not
// observed page history. Never echo them (or unrecognized planner fields)
// back to the strict outbound history contract on the next step.
function plannerHistoryEntry(plan, result) {
  const allowed = ['action', 'intent', 'reason', 'planner', 'amazonDiagnostic', 'verification', 'model'];
  const entry = Object.fromEntries(allowed.filter(key => Object.hasOwn(plan, key))
    .map(key => [key, plan[key]]));
  if (result !== undefined) entry.result = sanitizePayload(result);
  return entry;
}
function mintLocalActionLease(tab, context, step) {
  const url = tab.url || context.url || 'about:blank';
  let origin;
  try { origin = url === 'about:blank' ? 'null' : new URL(url).origin; }
  catch { throw new Error('Cannot bind an action to an invalid page origin.'); }
  return {
    tabId: tab.id, windowId: tab.windowId, frameId: 0, url, origin,
    documentGeneration: context.pageMetadata?.documentToken || context.pageMetadata?.domFingerprint || `local-step-${step}`,
    observationId: `local-observation-${++observationSequence}`,
    createdMonotonicMs: performance.now(), navigationEpoch: observationSequence,
    ttlMs: 120_000, active: true, abortSignal: taskAbort?.signal,
  };
}
async function validatePlannedActionOnDevice(plan, context, tab, lease) {
  checkpoint();
  const gate = globalThis.CAPTAIN_ACTION_BINDING;
  if (!gate?.validateActionOnDevice) {
    // The real Chrome extension has runtime.id and must use its packaged gate.
    // Old VM-only source tests do not load the background entry module.
    if (chrome.runtime?.id) throw new Error('Local action binding is unavailable; the action was blocked.');
    return enforceActionPrivacy(plan.action, context.elements || []);
  }
  const current = await chrome.tabs.get(tab.id);
  if (!current || current.id !== lease.tabId || current.windowId !== lease.windowId ||
    (current.url || 'about:blank') !== lease.url) {
    gate.invalidateTaskBinding(lease, 'navigation');
    throw new Error('Working tab changed after observation; action blocked.');
  }
  let elements = context.elements || [];
  if (BOUND_TARGET_ACTIONS.has(plan.action?.type)) {
    const originalPerception = perceptionLease(context);
    if (chrome.runtime?.id && !completePerceptionLease(originalPerception)) {
      gate.invalidateTaskBinding(lease, 'new-observation');
      throw new Error('Page identity is unavailable; action blocked.');
    }
    // A model can take seconds. Never trust cN refs from the earlier snapshot
    // without re-observing the trusted content script immediately before action.
    const latest = await send(tab.id, { type: 'OBSERVE' }, 1);
    const sameOrigin = (() => {
      try { return new URL(latest.url).origin === lease.origin; } catch { return false; }
    })();
    const freshPerception = perceptionLease(latest);
    if (!sameOrigin || latest.url !== context.url || (context.pageMetadata?.domFingerprint &&
      latest.pageMetadata?.domFingerprint !== context.pageMetadata.domFingerprint) ||
      (chrome.runtime?.id && (!completePerceptionLease(freshPerception) ||
        freshPerception.documentToken !== originalPerception.documentToken ||
        freshPerception.domRevision !== originalPerception.domRevision ||
        freshPerception.geometryRevision !== originalPerception.geometryRevision))) {
      gate.invalidateTaskBinding(lease, 'new-observation');
      throw new Error('Page changed while planning; action blocked pending fresh observation.');
    }
    elements = latest.elements || [];
    // The page checks this again *at dispatch*, closing the reobserve/execute
    // race. The planner cannot choose or alter this locally minted guard.
    lease.executionGuard = completePerceptionLease(freshPerception) ? freshPerception : null;
  }
  lease.nowMonotonicMs = performance.now();
  return gate.validateActionOnDevice(plan, { ...lease, elements, url: current.url || 'about:blank' }, lease);
}
const SAFE_EVENT_FIELDS = new Set(['step', 'actionType', 'phase', 'status', 'provider', 'model', 'latencyMs', 'piiDetected', 'recoveryCount', 'pageChange', 'reasonCode']);
// The telemetry endpoint intentionally rejects arbitrary vision fields. The
// page observation is richer than this contract; never serialize it wholesale
// into metrics, even when its strings are sanitized for planner use.
function metricProjection(latencyMs, piiDetected, steps, vision = {}) {
  const safe = { rawScreenshotTransmitted: false };
  if (['DOM+UltraFace+local-redaction', 'DOM+Amazon-semantic-fast-path'].includes(vision.mode)) safe.mode = vision.mode;
  if (['sanitized', 'dom-sanitized-fast-path', 'visual-disabled'].includes(vision.status)) safe.status = vision.status;
  for (const key of ['faces', 'redactionBoxes', 'inferenceMs', 'totalMs']) {
    const value = vision[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 3_600_000) safe[key] = Math.round(value);
  }
  return { latencyMs, piiDetected, steps, vision: safe };
}
function timelineEvent(timeline, started, type, metadata = {}) {
  const safe = Object.fromEntries(Object.entries(metadata).filter(([key, value]) => SAFE_EVENT_FIELDS.has(key) && ['string', 'number', 'boolean'].includes(typeof value)).map(([key, value]) => {
    if (typeof value !== 'string') return [key, value];
    try { return [key, sanitizeCommand(value).slice(0, 80)]; }
    catch { return [key, '[WITHHELD]']; }
  }));
  timeline.push({ type, atMs: Math.max(0, Math.round(performance.now() - started)), ...safe });
  if (timeline.length > 260) timeline.splice(0, timeline.length - 260);
}
function pageChange(before, after) {
  if (!before) return 'INITIAL';
  if (after?.challenge?.detected) return 'BLOCKED';
  if (before.url !== after?.url) return 'NAVIGATION';
  if (before.pageMetadata?.domFingerprint === after?.pageMetadata?.domFingerprint && before.pageMetadata?.visibleTextHash === after?.pageMetadata?.visibleTextHash) return 'NO_CHANGE';
  if (after?.pageMetadata?.meaningfulContent === false) return 'LOADING';
  return 'EXPECTED_CHANGE';
}
function checkpoint() { if (taskAbort?.signal.aborted) throw new Error('Task cancelled. An action already sent to the page cannot be undone.'); }
async function bounded(promise, ms, label) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out; the action was not repeated.`)), ms); })]); }
  finally { clearTimeout(timer); }
}
async function bindTarget(tab, originId) {
  const binding = { tabId: tab.id, windowId: tab.windowId };
  const values = { [`captainWindow:${tab.windowId}`]: binding };
  if (originId) values[`captainTarget:${originId}`] = binding;
  await chrome.storage.session.set(values);
  return tab;
}
async function resolveTarget(tabId, controllerWindowId) {
  if (controllerWindowId) {
    const window = await chrome.windows.get(controllerWindowId);
    if (window.incognito) throw new Error('CAPTAIN must run in a normal browser window.');
    const windowKey = `captainWindow:${controllerWindowId}`;
    const windowBinding = (await chrome.storage.session.get(windowKey))[windowKey];
    const legacyKey = `captainTarget:${tabId}`;
    const legacyBinding = tabId ? (await chrome.storage.session.get(legacyKey))[legacyKey] : null;
    const selected = windowBinding || legacyBinding;
    let tab;
    // A command from an in-page panel or an explicit controller target belongs
    // to THAT tab. A previous window binding must never silently override it.
    if (tabId) { try { tab = await chrome.tabs.get(tabId); } catch { /* Closed explicit target: use the established recovery path. */ } }
    const selectedId = selected?.tabId || tabId;
    if (!tab && selectedId) { try { tab = await chrome.tabs.get(selectedId); } catch { /* Closed target: recover inside the controller's window. */ } }
    if (tab && (tab.incognito || tab.windowId !== controllerWindowId)) throw new Error('The working tab moved to another window. Open CAPTAIN from a website tab in this normal window to reconnect.');
    if (tab?.url?.startsWith(chrome.runtime.getURL(''))) tab = null;
    if (!tab) {
      checkpoint();
      tab = await chrome.tabs.create({ windowId: controllerWindowId, url: 'about:blank', active: true });
      await bindTarget(tab, tabId);
      return { ...tab, captainRecovered: true };
    }
    return bindTarget(tab, tabId);
  }
  if (!tabId) return activeTab();
  const key = `captainTarget:${tabId}`;
  const saved = (await chrome.storage.session.get(key))[key];
  let tab;
  try { tab = await chrome.tabs.get(saved?.tabId || tabId); }
  catch { throw new Error('The selected task tab was closed. Open CAPTAIN from the website tab you want to control.'); }
  if (saved && tab.windowId !== saved.windowId) throw new Error('The selected tab moved to another window. Reconnect CAPTAIN from that tab.');
  return tab;
}
async function sessionTarget(windowId, originId) {
  if (!windowId) return null;
  const key = `captainWindow:${windowId}`, saved = (await chrome.storage.session.get(key))[key];
  const legacyKey = `captainTarget:${originId}`, legacy = originId ? (await chrome.storage.session.get(legacyKey))[legacyKey] : null;
  const id = saved?.tabId || legacy?.tabId || originId;
  let tab;
  try { if (id) tab = await chrome.tabs.get(id); } catch {}
  const connected = !!tab && !tab.incognito && tab.windowId === windowId && !tab.url?.startsWith(chrome.runtime.getURL(''));
  return { connected, windowId, tabId: connected ? tab.id : null, message: connected ? `Working tab ${tab.id} · same normal window` : 'No working tab. Your next command will open one in this normal window.' };
}
// One privacy session per running task. Raw values stay inside its closure;
// neither a placeholder mapping nor original strings enter storage or egress.
let activePrivacySession = null;
const PRIVATE_TEXT_FIXTURE = [/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, /(?<!\d)(?:\+?91[-\s]?)?[6-9]\d{9}(?!\d)/g, /\b\d{4}[ -]?\d{4}[ -]?\d{4}\b/g, /\b[A-Z]{5}\d{4}[A-Z]\b/g];
function privacySession() {
  const factory = globalThis.CAPTAIN_PRIVACY?.createSession;
  if (typeof factory !== 'function') {
    // The legacy source-only VM fixtures evaluate service-worker.js directly.
    // A real packaged extension has runtime.id and MUST load its local engine.
    if (chrome.runtime?.id) throw new Error('Local privacy engine unavailable; task blocked.');
    return null;
  }
  return activePrivacySession ||= factory();
}
function clearPrivacySession() {
  activePrivacySession?.clear?.();
  activePrivacySession = null;
}
function sanitizeCommand(value, options = {}) {
  const original = String(value ?? '');
  const session = privacySession();
  if (!session) return [...PRIVATE_TEXT_FIXTURE, /\b(?:\d[ -]*?){13,19}\b/g].reduce((text, pattern) => text.replace(pattern, '[REDACTED_PII]'), original);
  const outcome = session.sanitizeText(original, options);
  if (!outcome || outcome.blocked || typeof outcome.text !== 'string') throw new Error('Private or uncertain text was withheld locally.');
  return outcome.text;
}
// A short typed "open <site>" command is safe to execute locally. Doing it
// here avoids scanning the page the person is leaving (or asking the planner
// to interpret a simple navigation) before the requested page is loaded.
// Keep this registry explicit: a brand name is never guessed into a domain.
const LOCAL_DIRECT_SITES = Object.freeze({
  youtube: 'https://www.youtube.com', google: 'https://www.google.com', gmail: 'https://mail.google.com',
  amazon: 'https://www.amazon.in', flipkart: 'https://www.flipkart.com', wikipedia: 'https://www.wikipedia.org',
  github: 'https://github.com', linkedin: 'https://www.linkedin.com', irctc: 'https://www.irctc.co.in',
  spotify: 'https://open.spotify.com/', netflix: 'https://www.netflix.com/in/', reddit: 'https://www.reddit.com/',
  instagram: 'https://www.instagram.com/', facebook: 'https://www.facebook.com/',
  whatsapp: 'https://web.whatsapp.com/', bing: 'https://www.bing.com/', duckduckgo: 'https://duckduckgo.com/',
  stackoverflow: 'https://stackoverflow.com/',
});
const LOCAL_DIRECT_ALIASES = Object.freeze({
  'you tube': 'youtube', 'g mail': 'gmail', 'google mail': 'gmail', 'git hub': 'github', 'linked in': 'linkedin',
  'spot ify': 'spotify', 'net flix': 'netflix', 'face book': 'facebook', 'insta gram': 'instagram',
  'whats app': 'whatsapp', 'duck duck go': 'duckduckgo', 'stack overflow': 'stackoverflow',
});
function normalizeDirectNavigationCommand(value) {
  let command = String(value ?? '').trim();
  // Normalize polite command prefixes without changing the requested site or URL.
  for (let count = 0; count < 4; count++) {
    const before = command;
    command = command.replace(/^(?:(?:hey|okay|ok)\s+)?captain\b[,\s:!.]*/i, '')
      .replace(/^hey\b[,\s:!]+(?=(?:open|launch|go to|navigate to)\b)/i, '')
      .replace(/^(?:can|could|would|will)\s+you\s+/i, '')
      .replace(/^please\b[,\s:]*/i, '').trim();
    if (command === before) break;
  }
  return command.replace(/[,\s]+(?:please|thank you|thanks)[.!?]*$/i, '').replace(/[.!?]+$/, '').trim();
}
function namedLocalDirectSite(value) {
  const name = String(value || '').trim().toLowerCase().replace(/^the\s+/, '')
    .replace(/\s+(?:website|site)$/, '').replace(/\s+/g, ' ');
  const canonical = LOCAL_DIRECT_ALIASES[name] || name;
  return Object.hasOwn(LOCAL_DIRECT_SITES, canonical) ? { name: canonical, url: LOCAL_DIRECT_SITES[canonical] } : null;
}
function explicitLocalNavigationUrl(value) {
  // A domain/URL typed by the user is explicit authority to navigate. This
  // parser accepts only HTTP(S), never credentials or executable schemes.
  const text = String(value || '').trim().replace(/\s+dot\s+/gi, '.');
  if (text.length < 3 || text.length > 2048 ||
      !/^(?:https?:\/\/)?(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?::\d{1,5})?(?:[/?#]\S*)?$/i.test(text)) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
    const port = url.port ? Number(url.port) : 0;
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
        (port && (!Number.isSafeInteger(port) || port < 1 || port > 65535))) return null;
    return url.href;
  } catch { return null; }
}
function localDirectNavigation(task) {
  const command = normalizeDirectNavigationCommand(task);
  const match = command.match(/^(?:open|launch|go to|navigate(?:\s+to)?)\s+(.+)$/i);
  if (!match) return null;
  const destination = match[1].trim();
  if (!destination || destination.length > 2048) return null;
  const named = namedLocalDirectSite(destination);
  if (named) return { url: named.url, source: 'named-site' };
  const url = explicitLocalNavigationUrl(destination);
  return url ? { url, source: 'explicit-url' } : null;
}
function sanitizePayload(value, key = '') {
  if (key === 'screenshot' || key === 'imageSha256' || key === 'modelSha256') return value;
  // Browser-generated, allowlisted integrity identifiers are not user text.
  // A real JPEG digest contains many digits and may otherwise be mistaken for
  // an opaque private token, aborting every real image-enabled planner request.
  // Preserve ONLY the exact shapes accepted by the companion's strict schema;
  // an arbitrary string in one of these fields must still fail closed.
  if (['sha256', 'sanitizedScreenshotFingerprint'].includes(key)) {
    if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))
      throw new Error('Local integrity identifier is unavailable.');
    return value;
  }
  if (['domFingerprint', 'visibleTextHash'].includes(key)) {
    if (typeof value !== 'string' || !/^[a-f0-9]{8}$/.test(value))
      throw new Error('Local integrity identifier is unavailable.');
    return value;
  }
  if (typeof value === 'string') return sanitizeCommand(value);
  if (typeof value === 'number') return Number.isFinite(value) ? Math.round(value * 1000) / 1000 : 0;
  if (Array.isArray(value)) return value.map(item => sanitizePayload(item, key));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,sanitizePayload(v, k)]));
  return value;
}
function assertNoPrivatePlannerText(value, key = '', parent = '') {
  // A redactionBoxes number in the device-owned vision summary is a COUNT,
  // not the raw pixel-region array. Preserve this tightly bounded scalar so
  // real screenshot-enabled tasks can persist their status. The same key in
  // any other location, or with any geometry/text payload, remains forbidden.
  if (key === 'redactionBoxes' && parent === 'vision' &&
      Number.isSafeInteger(value) && value >= 0 && value <= 500) return;
  if (['screenshot', 'rawScreenshot', 'visualPrivacy', 'screenshotMetadata', 'redactionBoxes'].includes(key))
    throw new Error('Untrusted image payload was withheld locally.');
  if (typeof value === 'string') {
    if (/data:image\//i.test(value)) throw new Error('Untrusted image payload was withheld locally.');
    if (sanitizeCommand(value) !== value) throw new Error('Planner supplied private text; action blocked.');
  } else if (Array.isArray(value)) value.forEach(item => assertNoPrivatePlannerText(item, key, parent));
  else if (value && typeof value === 'object') for (const [name, item] of Object.entries(value)) assertNoPrivatePlannerText(item, name, key);
}

async function settings() { return { ...DEFAULTS, ...(await chrome.storage.sync.get(DEFAULTS)) }; }
async function state(value) {
  let safe;
  try { assertNoPrivatePlannerText(value); safe = sanitizePayload({ updatedAt: Date.now(), ...value }); }
  catch { safe = { updatedAt: Date.now(), status: 'error', message: 'Privacy protection withheld local task status.',
    ...(Number.isSafeInteger(value.windowId) ? { windowId: value.windowId } : {}),
    ...(typeof value.requestId === 'string' && /^text-[a-z0-9]{1,16}-[a-z0-9]{1,10}$/.test(value.requestId) ? { requestId: value.requestId } : {}) }; }
  await chrome.storage.local.set({ captainState: safe });
}
async function activeTab() { const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); return tab; }
async function chromeEdit(operation) {
  for (let attempt = 0; ; attempt++) {
    checkpoint();
    try { return await operation(); }
    catch (error) {
      // Chrome explicitly rejects these edits during tab-strip interactions.
      // No other failure (especially an uncertain action) is repeated here.
      if (attempt >= 9 || !/tabs cannot be edited right now/i.test(error.message)) throw error;
      await new Promise(resolve => setTimeout(resolve, 300));
    }
  }
}
async function focusTarget(tab) {
  let window = await chrome.windows.get(tab.windowId);
  if (window.state === 'minimized') {
    await chromeEdit(() => chrome.windows.update(tab.windowId, { state: 'normal' }));
    window = await chrome.windows.get(tab.windowId);
  }
  // Some Windows restore paths leave a title-bar-sized window, not a usable viewport.
  if (window.state === 'normal' && (window.height < 400 || window.width < 600)) await chromeEdit(() => chrome.windows.update(tab.windowId, { width: 1180, height: 800, left: 20, top: 20 }));
  await chromeEdit(() => chrome.tabs.update(tab.id, { active: true }));
  await chromeEdit(() => chrome.windows.update(tab.windowId, { focused: true }));
}
async function verifyRequestedPlayback(tab, query, onWait) {
  const deadline = Date.now() + 90000;
  let verification, resumeAttempts = 0;
  do {
    checkpoint();
    await focusTarget(tab);
    verification = await send(tab.id, { type: 'EXECUTE', action: { type: 'verifyPlayback', query } });
    if (verification.ok && verification.verified === true) return verification;
    if (!verification.retryable) throw new Error(verification.error || 'The page did not provide verified playback evidence.');
    await onWait(verification.error);
    if (verification.needsResume && resumeAttempts < 2) {
      // An ad/source transition can pause the requested video after play was accepted.
      // Retry only a title-checked paused player, not buffering media or unknown pages.
      checkpoint();
      resumeAttempts++;
      const resumed = await send(tab.id, { type: 'EXECUTE', action: { type: 'media', operation: 'play' } });
      if (resumed.requiresPlayClick) await trustedPlayClick(tab, resumed.requiresPlayClick);
      else if (!resumed.ok) throw new Error(resumed.error || 'Could not resume the requested player.');
    }
    await new Promise(resolve => setTimeout(resolve, 1500));
  } while (Date.now() < deadline);
  throw new Error(`Playback was not verified within 90 seconds. ${verification.error}`);
}
async function trustedPlayClick(tab, point) {
  checkpoint();
  if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y) || point.x < 0 || point.y < 0) throw new Error('Invalid player control position.');
  if (!chrome.debugger?.attach) throw new Error('This browser does not support the trusted coordinate-click fallback.');
  const debuggee = { tabId: tab.id };
  await focusTarget(tab);
  await chrome.debugger.attach(debuggee, '1.3');
  try {
    checkpoint();
    await chrome.debugger.sendCommand(debuggee, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    await chrome.debugger.sendCommand(debuggee, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  } finally { await chrome.debugger.detach(debuggee); }
}
async function send(tabId, message, retries = message.type === 'OBSERVE' ? 45 : 1) {
  const deadline = Date.now() + 30000;
  let reinjected = false, lastError;
  for (let i = 0; i < retries; i++) {
    checkpoint();
    if (Date.now() >= deadline) break;
    try { return await bounded(chrome.tabs.sendMessage(tabId, message), 8000, 'Page response'); }
    catch (error) {
      if (message.type !== 'OBSERVE') throw error;
      lastError = error;
      if (!reinjected && /receiving end does not exist|could not establish connection|extension context invalidated/i.test(error.message)) {
        checkpoint();
        const tab = await chrome.tabs.get(tabId);
        if (tab.incognito) throw new Error('Page reconnection requires a normal tab.');
        // Do not spend the one recovery attempt on an old/unloading document.
        // Once the committed HTTPS page is complete, inject exactly once.
        if (tab.status === 'complete' && !tab.pendingUrl && /^https?:\/\//.test(tab.url || '')) {
          // Programmatic reinjection does not inherit manifest ordering. Load
          // the local privacy engine first or the actual content script blocks.
          await chrome.scripting.executeScript({ target: { tabId }, files: ['privacy/privacy-core.js', 'content-script.js'] });
          reinjected = true;
        }
      }
      await new Promise((r) => setTimeout(r, 700));
    }
  }
  throw new Error(message.type === 'OBSERVE' ? `The page did not become readable within 30 seconds. ${lastError?.message || 'Check whether it loaded or shows a network error.'}` : 'The page changed while executing the action; the action was not repeated.');
}
async function captureWorkingTab(tab) {
  await assertCaptureTab(tab);
  // Capture the page, never CAPTAIN's own floating controls. Their changing
  // status/OCR can make an otherwise safe page unnecessarily all-black. The
  // hide/restore operation is exclusively on the extension-owned panel and
  // does not weaken page-origin PII, face, OCR, UI or proof requirements.
  let panelHideRequested = false;
  try {
  panelHideRequested = true;
  const hidden = await send(tab.id, { type: 'CAPTURE_PANEL', mode: 'hide' }, 1);
  if (hidden?.ok !== true) throw new Error(VISUAL_CAPTURE_ERROR);
  let lastError;
  // Always give Chrome's native active-tab capture a fresh chance for every
  // task. A transient image-readback failure on one public page must not force
  // every later page through the debugger path.
  for (let attempt = 0; attempt < 2; attempt++) {
    checkpoint();
    await focusTarget(tab);
    const [active] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
    if (active?.id !== tab.id) throw new Error('Visual capture refused because the working tab is not active.');
    try {
    const image = await bounded(chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 82 }), 2500, 'Local screen capture');
      await assertCaptureTab(tab);
      return image;
    }
    catch (error) {
      lastError = error;
      if (!/(?:image readback failed|Local screen capture timed out)/i.test(error.message || '')) throw error;
      await new Promise(resolve => setTimeout(resolve, 400 * (attempt + 1)));
    }
  }
  if (!chrome.debugger?.attach) throw lastError;
  // This flag is observability only. It is reset after this one fallback; it
  // must never become a process-wide capture mode after a temporary failure.
  preferDebuggerCapture = true;
  const debuggee = { tabId: tab.id };
  let attached = false;
  try {
    await bounded(chrome.debugger.attach(debuggee, '1.3'), 1800, 'Local debugger capture setup');
    attached = true;
    checkpoint();
    const captured = await bounded(chrome.debugger.sendCommand(debuggee, 'Page.captureScreenshot', {
      format: 'jpeg', quality: 82, fromSurface: true
    }), 3500, 'Local debugger screen capture');
    if (!captured?.data) throw lastError;
    await assertCaptureTab(tab);
    return `data:image/jpeg;base64,${captured.data}`;
  } finally {
    preferDebuggerCapture = false;
    if (attached) await chrome.debugger.detach(debuggee).catch(() => undefined);
  }
  } finally {
    if (panelHideRequested) {
      const restored = await send(tab.id, { type: 'CAPTURE_PANEL', mode: 'restore' }, 1)
        .catch(() => null);
      if (restored?.ok !== true) throw new Error(VISUAL_CAPTURE_ERROR);
    }
  }
}
function validLocalFieldSnapshot(value) {
  return value && !value.error && typeof value.documentToken === 'string' && value.documentToken.length > 0 &&
    Number.isSafeInteger(value.domRevision) && Number.isSafeInteger(value.geometryRevision) &&
    value.viewport && ['width', 'height', 'devicePixelRatio'].every(key => Number.isFinite(value.viewport[key]) && value.viewport[key] > 0) &&
    Array.isArray(value.boxes) && value.boxes.length <= 500 && value.boxes.every(box =>
      box && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(box[key]) && Math.abs(box[key]) <= 16384) &&
      box.width > 0 && box.height > 0 && /^(?:EMAIL|PHONE|CARD|AADHAAR|PAN|ADDRESS|PERSON|NAME|FULL_NAME|PASSWORD|OTP|CVV|PIN|TOKEN|API_KEY|SECRET|PII|CREDENTIAL|DATE_OF_BIRTH|DOB|PASSPORT|PASSPORT_NUMBER|ACCOUNT|ACCOUNT_NUMBER|IFSC)$/.test(box.kind));
}
async function readLocalFieldSnapshot(tab) {
  const value = await chrome.tabs.sendMessage(tab.id, { type: 'LOCAL_FIELD_SNAPSHOT' });
  if (!validLocalFieldSnapshot(value)) throw new Error('Local field scan unavailable.');
  return value;
}
function sameLocalFieldSnapshot(before, after) {
  return validLocalFieldSnapshot(before) && validLocalFieldSnapshot(after) &&
    before.documentToken === after.documentToken && before.domRevision === after.domRevision &&
    before.geometryRevision === after.geometryRevision &&
    JSON.stringify(before.viewport) === JSON.stringify(after.viewport) && JSON.stringify(before.boxes) === JSON.stringify(after.boxes);
}
// Local display only: never assign this PNG to observation.screenshot or an
// outbound proof. It depicts known fields; image-only content is not certified.
async function renderLocalFieldPreview(rawScreenshot, snapshot) {
  if (!validLocalFieldSnapshot(snapshot) || !/^data:image\/jpeg;base64,/.test(rawScreenshot || ''))
    throw new Error('Local field preview unavailable.');
  const bitmap = await createImageBitmap(await (await fetch(rawScreenshot)).blob());
  try {
    const { width, height } = bitmap;
    const sx = width / snapshot.viewport.width, sy = height / snapshot.viewport.height;
    if (width < 1 || height < 1 || width * height > 12_000_000 ||
        Math.max(sx, sy) / Math.min(sx, sy) > 1.02) throw new Error('Local preview geometry changed.');
    const canvas = new OffscreenCanvas(width, height), ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Local preview canvas unavailable.');
    ctx.drawImage(bitmap, 0, 0);
    ctx.fillStyle = '#000';
    for (const box of snapshot.boxes) {
      // Two pixels cover field borders and glyph antialiasing, never a parent panel.
      const left = Math.max(0, Math.floor(box.x * sx) - 2), top = Math.max(0, Math.floor(box.y * sy) - 2);
      const right = Math.min(width, Math.ceil((box.x + box.width) * sx) + 2);
      const bottom = Math.min(height, Math.ceil((box.y + box.height) * sy) + 2);
      if (right > left && bottom > top) ctx.fillRect(left, top, right - left, bottom - top);
    }
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    if (blob.size > 2_500_000) throw new Error('Local preview too large.');
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return `data:image/png;base64,${btoa(binary)}`;
  } finally { bitmap.close(); }
}
async function publishLocalFieldPreview(tab, rawScreenshot, before) {
  if (!sameLocalFieldSnapshot(before, await readLocalFieldSnapshot(tab))) throw new Error('Page changed during local capture.');
  const screenshot = await renderLocalFieldPreview(rawScreenshot, before);
  await assertCaptureTab(tab);
  if (!sameLocalFieldSnapshot(before, await readLocalFieldSnapshot(tab))) throw new Error('Page changed during local masking.');
  await send(tab.id, { type: 'SHOW_SENSITIVE_REDACTION_NOTICE', boxes: before.boxes }, 1);
  const shown = await send(tab.id, { type: 'SHOW_LOCAL_FIELD_PREVIEW', screenshot,
    localOnly: true, fullBlackout: false, redactionBoxes: before.boxes.length, faces: 0, rawScreenshotTransmitted: false }, 1);
  if (shown?.ok !== true) throw new Error('Local preview could not be displayed.');
  return before.boxes.length;
}
async function captureLocalFieldPreview(tab) {
  if (!tab || tab.incognito || !/^https?:\/\//.test(tab.url || '')) throw new Error('Open a normal website tab first.');
  await assertCaptureTab(tab);
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = await readLocalFieldSnapshot(tab);
    const rawScreenshot = await captureWorkingTab(tab);
    try { return await publishLocalFieldPreview(tab, rawScreenshot, before); }
    catch (error) { if (attempt === 2) throw error; }
  }
}

async function observe(tab, config, freshCaptureRetry = 0) {
  if (/^(?:about:blank|chrome:\/\/|edge:\/\/)/.test(tab.url || '')) {
    return { url: 'about:blank', title: 'New browser tab', site: '', elements: [], media: [], piiCounts: {}, vision: { status: 'visual-disabled' } };
  }
  const domStarted = performance.now();
  let context = await send(tab.id, { type: 'OBSERVE', captureRequested: !!config.includeScreenshot });
  if (!context || context.error || (chrome.runtime?.id && !completePerceptionLease(perceptionLease(context))))
    throw new Error('Local observation failed; page information withheld.');
  context.localTiming = { ...context.localTiming, extensionDomRoundTripMs: Math.round(performance.now() - domStarted) };
  // A human challenge is a local stop, not planner input. Do not require a
  // screenshot proof merely to ask the user to complete verification.
  // Resuming always performs a new full observation/capture below.
  if (context.challenge?.detected) {
    delete context.redactionBoxes;
    context.vision = { status: 'withheld-human-verification', rawScreenshotTransmitted: false };
    return context;
  }
  if (config.includeScreenshot) {
    let diagnosticStage = 'preflight'; // trusted service worker only; never egress
    try {
      const rollingCoverage = await collectRollingCaptureCoverage(tab, context, config.rollingCaptureSamples);
      context = rollingCoverage.context;
      if (!completeVisualObservation(context)) throw new Error(VISUAL_CAPTURE_ERROR);
      const coverageOptions = rollingCoverage.rolling ? { allowDomRevisionDrift: true, allowGeometryRevisionDrift: true } : undefined;
      diagnosticStage = 'capture';
      const fieldSnapshot = await readLocalFieldSnapshot(tab).catch(() => null);
      const captureStarted = performance.now();
      const rawScreenshot = await captureWorkingTab(tab);
      context.localTiming.captureMs = Math.round(performance.now() - captureStarted);
      await assertCaptureTab(tab);
      diagnosticStage = 'capture-lease';
      const afterCapture = await send(tab.id, { type: 'OBSERVE', captureRequested: true }, 1);
      if (!sameVisualObservation(context, afterCapture) &&
          !visualObservationCoveredByCapture(context, afterCapture, coverageOptions)) {
        const rejected = new Error(VISUAL_CAPTURE_ERROR);
        rejected.captainVisualReason = visualLeaseReason(context, afterCapture, coverageOptions);
        throw rejected;
      }
      await assertCaptureTab(tab);
      const localShown = fieldSnapshot && await publishLocalFieldPreview(tab, rawScreenshot, fieldSnapshot).then(() => true, () => false);
      diagnosticStage = 'worker-send';
      const visualStarted = performance.now();
      const privateHost = await ensurePrivateVisionHost();
      const responsePending = chrome.runtime.sendMessage({ type: 'VISION_REDACT', windowId: tab.windowId,
        ...(privateHost ? { visionHost: 'offscreen' } : {}),
        screenshot: rawScreenshot, viewport: context.viewport, redactionBoxes: context.redactionBoxes,
        uiSnapshot: localUISnapshot(context) });
      diagnosticStage = 'worker-await';
      const result = await bounded(responsePending, 105000, 'Local visual privacy');
      diagnosticStage = 'worker-proof';
      const visual = await verifyVisualResult(result, rawScreenshot);
      context.localTiming.localVisionAndRedactionMs = Math.round(performance.now() - visualStarted);
      await assertCaptureTab(tab);
      diagnosticStage = 'redaction-lease';
      const afterRedaction = await send(tab.id, { type: 'OBSERVE', captureRequested: true }, 1);
      if (!sameVisualObservation(context, afterRedaction) &&
          !visualObservationCoveredByCapture(context, afterRedaction, coverageOptions)) {
        // A public page can change mask geometry during local OCR without a
        // tracked DOM/viewport revision. The old proof covers the OLD boxes:
        // discard the complete old capture/proof and restart the ENTIRE local
        // observation/capture/worker/lease pipeline at most once. A changed
        // document, revision, URL, viewport or incomplete mask list NEVER
        // qualifies. Neither the old JPEG nor raw pixels reach the planner.
        if (freshCaptureRetry === 0 && sameVisualObservationExceptBoxes(context, afterRedaction, coverageOptions)) {
          checkpoint();
          await assertCaptureTab(tab);
          return await observe(tab, config, 1);
        }
        const rejected = new Error(VISUAL_CAPTURE_ERROR);
        rejected.captainVisualReason = visualLeaseReason(context, afterRedaction, coverageOptions);
        throw rejected;
      }
      await assertCaptureTab(tab);
      if (visual.visualPrivacy.fullBlackout !== true) {
        context.screenshot = visual.screenshot;
        context.visualPrivacy = visual.visualPrivacy;
        context.screenshotMetadata = { sanitized: true, format: 'image/jpeg', bytes: visual.visualPrivacy.outputBytes, sha256: visual.visualPrivacy.imageSha256, rawScreenshotTransmitted: false };
        context.pageMetadata = { ...context.pageMetadata, sanitizedScreenshotFingerprint: visual.visualPrivacy.imageSha256 };
      }
      context.vision = { ...context.vision, mode: 'DOM+UltraFace+local-redaction', status: 'sanitized', faces: visual.visualPrivacy.faces, redactionBoxes: visual.visualPrivacy.domBoxes, inferenceMs: visual.visualPrivacy.inferenceMs, totalMs: visual.visualPrivacy.totalMs };
      if (visual.visualPrivacy.fullBlackout === true) context.vision.status = 'image-withheld';
      // Before the planner request, identify the locally detected categories
      // and mark their page regions for the user. The original values stay on
      // the page; they are never copied into this notice or its message.
      if (!localShown) await send(tab.id, {
        type: 'SHOW_SENSITIVE_REDACTION_NOTICE',
        boxes: context.redactionBoxes.filter(box => !['RASTER_CONTENT', 'BACKGROUND_IMAGE', 'UNKNOWN'].includes(box.kind))
          .map(({ x, y, width, height, kind }) => ({ x, y, width, height, kind })),
      }, 1).catch(() => undefined);
      // The user-facing field preview is independent of outbound certification.
      // Never replace it with blanket raster masks or a black frame.
      if (!localShown) await send(tab.id, { type: 'LOCAL_FIELD_PREVIEW_UNAVAILABLE' }, 1).catch(() => undefined);
    } catch (error) {
      if (diagnosticStage === 'worker-await' && /timed out/i.test(error?.message || ''))
        await disposeTimedOutVisualWorker(tab);
      // Keep only a fixed local stage label for diagnostics.  It never
      // contains page text, coordinates, screenshot data, or an error thrown
      // by page code, and the UI intentionally does not render it.
      const withheld = new Error(VISUAL_CAPTURE_ERROR);
      withheld.captainVisualStage = diagnosticStage;
      if (['invalid-observation', 'document', 'dom-revision', 'geometry-revision', 'geometry-page-scroll', 'geometry-window-resize', 'geometry-viewport-resize', 'geometry-viewport-scroll', 'scroll-position', 'url', 'viewport', 'uncovered-protected-region'].includes(error?.captainVisualReason))
        withheld.captainVisualReason = error.captainVisualReason;
      throw withheld;
    }
  } else if (config.amazonDomFastPath) context.vision = { ...context.vision, mode: 'DOM+Amazon-semantic-fast-path', status: 'dom-sanitized-fast-path', rawScreenshotTransmitted: false };
  else context.vision = { ...context.vision, status: 'visual-disabled' };
  delete context.redactionBoxes;
  return context;
}
async function observeStable(tab, config) {
  for (let attempt = 0; ; attempt++) {
    try { return await observe(tab, config); }
    catch (error) {
      // A dynamic page can settle after the initial readiness samples. Never
      // reuse its rejected capture: retry the complete local pipeline before
      // any consent, planner request or action. Other failures stay terminal.
      if (attempt >= 2 || !['capture-lease', 'redaction-lease'].includes(error?.captainVisualStage)) throw error;
      checkpoint();
      await assertCaptureTab(tab);
      await waitForPrivacyScanReady(tab);
      checkpoint();
    }
  }
}
async function navigateSameTab(tabId, rawUrl, expected = {}) {
  const navigationStarted = Date.now();
  const destination = new URL(rawUrl);
  if (!['https:', 'http:'].includes(destination.protocol)) throw new Error('Unsupported navigation URL.');
  const tab = await chrome.tabs.get(tabId);
  if (tab.incognito) throw new Error('Navigation requires a normal tab.');
  await chromeEdit(() => chrome.tabs.update(tabId, { url: destination.href }));
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    checkpoint();
    const current = await chrome.tabs.get(tabId);
    let arrived = false, sameHost = false;
    try {
      const actual = new URL(current.url);
      sameHost = actual.hostname.replace(/^www\./, '') === destination.hostname.replace(/^www\./, '');
      const queryMatches = [...destination.searchParams].every(([k,v]) => actual.searchParams.get(k) === v);
      const exactPath = actual.pathname === destination.pathname;
      // Stack Overflow's reviewed root route canonically lands on /questions.
      // Chrome can preserve that already-committed canonical document when the
      // user repeats “open stackoverflow.com”, so a URL-change check alone
      // would wait 45 seconds despite a readable correct-site page. Keep this
      // narrowly allowlisted; arbitrary deep links never qualify as home.
      const reviewedCanonicalHome = destination.hostname.replace(/^www\./, '') === 'stackoverflow.com' && /^\/questions\/?$/.test(actual.pathname);
      const homeRedirect = destination.pathname === '/' && !destination.search && (current.url !== tab.url || reviewedCanonicalHome);
      const slashRedirect = actual.pathname.replace(/\/$/, '') === destination.pathname.replace(/\/$/, '');
      arrived = sameHost && queryMatches && (exactPath || homeRedirect || slashRedirect);
    } catch {}
    let signIn = false, gmailLanding = false;
    try {
      const actual = new URL(current.url);
      signIn = ['mail.google.com', 'accounts.google.com'].includes(destination.hostname) && actual.hostname === 'accounts.google.com';
      gmailLanding = destination.hostname === 'mail.google.com' && actual.hostname === 'workspace.google.com' && /^\/(?:intl\/[a-z-]+\/)?gmail\/?$/i.test(actual.pathname);
    } catch {}
    if ((arrived || signIn || gmailLanding) && current.status === 'complete' && !current.pendingUrl) return { ok: true, navigated: true, navigationMs: Date.now() - navigationStarted, ...(signIn || gmailLanding ? { requiresSignIn: true } : {}) };
    // Streaming pages can remain "loading" after their usable DOM is ready.
    if ((arrived || (expected.searchValue && sameHost)) && !current.pendingUrl) {
      let timer;
      try {
        const readinessBudgetMs = /(^|\.)amazon\.in$/i.test(destination.hostname) ? 900 : 1200;
        const readable = await Promise.race([chrome.tabs.sendMessage(tabId, { type: 'READINESS' }), new Promise(resolve => { timer = setTimeout(() => resolve(null), readinessBudgetMs); })]);
        const usable = (readable?.ready && readable?.meaningfulContent) || (Array.isArray(readable?.elements) && readable.elements.length > 0);
        // A confirmed same-host home redirect may have a different path.
        // Bind readiness to the actual committed document, not the old URL.
        const actual = new URL(current.url);
        if (arrived && readable?.url === `${actual.origin}${actual.pathname}` && usable) return { ok: true, navigated: true, navigationMs: Date.now() - navigationStarted };
        const observedQuery = String(readable?.searchQuery || '').trim().toLocaleLowerCase();
        const expectedQuery = String(expected.searchValue || '').trim().toLocaleLowerCase();
        if (sameHost && expectedQuery && observedQuery === expectedQuery && usable) return { ok: true, navigated: true, canonicalized: true, navigationMs: Date.now() - navigationStarted };
      } catch {} finally { clearTimeout(timer); }
    }
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  throw new Error('The requested page did not finish loading in 45 seconds. Navigation was not repeated.');
}
// A browser's `complete` state means its document was committed, not that the
// page-local privacy engine has finished attaching to the new document.  A
// direct text navigation must not race from that transition into a capture:
// wait for three small, extension-only readiness samples before the first OBSERVE
// call.  These samples contain no page text, form values, OCR, or pixels.
function usablePrivacyReadiness(readiness, currentUrl) {
  if (!readiness || readiness.error || typeof readiness.url !== 'string') return false;
  let observed;
  try { observed = new URL(currentUrl); } catch { return false; }
  const currentOriginPath = `${observed.origin}${observed.pathname}`;
  const usable = (readiness.ready && readiness.meaningfulContent) ||
    (Number.isFinite(readiness.amazonResultCards) && readiness.amazonResultCards >= 3);
  return readiness.url === currentOriginPath && usable &&
    typeof readiness.documentToken === 'string' && readiness.documentToken.length > 0 &&
    Number.isSafeInteger(readiness.domRevision) && readiness.domRevision >= 0 &&
    Number.isSafeInteger(readiness.geometryRevision) && readiness.geometryRevision >= 0;
}
// `VISUAL_STABILITY` is an extension-local pacing sample. Its structural
// digests are opaque and cannot replace the strict redaction-box comparison in
// `observe()`; they only prevent a raw capture from starting while a SPA or an
// advertising-heavy public page is still constructing its visible surface.
function usableVisualStability(stability, currentUrl) {
  if (!stability || stability.ok !== true || typeof stability.url !== 'string') return false;
  let observed;
  try { observed = new URL(currentUrl); } catch { return false; }
  if (stability.url !== `${observed.origin}${observed.pathname}` ||
      typeof stability.documentToken !== 'string' || !stability.documentToken ||
      !Number.isSafeInteger(stability.domRevision) || stability.domRevision < 0 ||
      !Number.isSafeInteger(stability.geometryRevision) || stability.geometryRevision < 0 ||
      !Number.isSafeInteger(stability.redactionCount) || stability.redactionCount < 0 || stability.redactionCount > 500 ||
      typeof stability.redactionDigest !== 'string' || !/^[a-f0-9]{8}$/i.test(stability.redactionDigest) ||
      typeof stability.visibleTextDigest !== 'string' || !/^[a-f0-9]{8}$/i.test(stability.visibleTextDigest) ||
      typeof stability.controlDigest !== 'string' || !/^[a-f0-9]{8}$/i.test(stability.controlDigest)) return false;
  const viewport = stability.viewport || {};
  return Number.isFinite(viewport.width) && viewport.width > 0 && viewport.width <= 16384 &&
    Number.isFinite(viewport.height) && viewport.height > 0 && viewport.height <= 16384 &&
    Number.isFinite(viewport.devicePixelRatio) && viewport.devicePixelRatio > 0 && viewport.devicePixelRatio <= 8;
}
async function waitForPrivacyScanReady(tab, { timeoutMs = 14000, sampleDelayMs = 350 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    checkpoint();
    const current = await chrome.tabs.get(tab.id);
    if (current.incognito) throw new Error('CAPTAIN actions require a normal tab.');
    // Ads/streaming resources may keep Chrome's tab status at "loading".
    // The extension's committed-document readiness and three stable leases
    // are the capture prerequisite, not completion of every network resource.
    if (!current.pendingUrl) {
      let readiness = null;
      try {
        readiness = await bounded(chrome.tabs.sendMessage(tab.id, { type: 'READINESS' }), 900, 'Page privacy readiness');
      } catch { /* The content script can still be attaching after navigation. */ }
      if (usablePrivacyReadiness(readiness, current.url)) {
        let visual = null;
        try {
          // The page returns only fixed-shape local metadata. A bounded sample
          // failure merely postpones capture; it does not expose an error or
          // partial page observation outside the extension.
          visual = await bounded(chrome.tabs.sendMessage(tab.id, { type: 'VISUAL_STABILITY' }), 5500, 'Page visual stability');
        } catch { /* retry until the bounded quiet window expires */ }
        if (usableVisualStability(visual, current.url)) {
          // This single completed local pass proves the privacy engine is
          // attached and readable. `observe()` immediately follows with a
          // bounded rolling union of later mask samples, then keeps the strict
          // before/after screenshot proof. Requiring all unrelated DOM work to
          // become motionless here starves safe captures on public SPAs.
          return { ready: true, waitMs: timeoutMs - Math.max(0, deadline - Date.now()) };
        } else {
          // Keep waiting for a complete local visual sample.
        }
      }
    }
    await new Promise(resolve => setTimeout(resolve, sampleDelayMs));
  }
  // Fail closed: no raw capture is attempted until the privacy engine has a
  // stable binding to the destination document.
  throw new Error(VISUAL_CAPTURE_ERROR);
}
async function backSameTab(tabId) {
  const started = Date.now(), before = await chrome.tabs.get(tabId);
  const requested = await chrome.tabs.sendMessage(tabId, { type: 'EXECUTE', action: { type: 'back' } });
  if (!requested?.ok) throw new Error(requested?.error || 'The page could not request back navigation.');
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    checkpoint();
    const current = await chrome.tabs.get(tabId);
    if (!current.pendingUrl && current.url !== before.url) {
      try {
        const observed = await bounded(chrome.tabs.sendMessage(tabId, { type: 'READINESS' }), 900, 'Back-navigation readiness');
        if (observed?.ready && observed?.meaningfulContent) return { ok: true, navigated: true, navigationMs: Date.now() - started };
      } catch { /* The returning document may still be committing. */ }
    }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error('The previous page did not become usable within 30 seconds.');
}
function completionSummary(plan, result, verification, history = []) {
  const message = result.message || plan.action.message;
  if (plan.action.completionStatus && plan.action.completionStatus !== 'COMPLETED') return { phase: plan.action.completionStatus === 'PARTIAL' ? 'Partial result' : plan.action.completionStatus, phaseCode: plan.action.completionStatus, completionStatus: plan.action.completionStatus, outcomeVerified: false, message };
  if (plan.action.clarification) return { phase: 'Waiting for your answer', phaseCode: 'VERIFYING', completionStatus: 'PARTIAL', message };
  // A successful device-bound click only verifies that the specified control
  // received the click. It does NOT prove the model chose the visual feature
  // requested by the user. A subsequent deterministic finish must not erase
  // that distinction or claim a semantic outcome without independent proof.
  const priorModelAction = history.some(entry => ['ollama', 'remote-vlm'].includes(entry.planner) &&
    entry.action?.type !== 'finish' && entry.result?.ok === true);
  if (priorModelAction && verification?.verified !== true)
    return { phase: 'Review required', phaseCode: 'VERIFYING', completionStatus: 'PARTIAL', outcomeVerified: false,
      message: 'A model-selected action was executed, but the requested outcome has not been independently verified. Please check the page.' };
  if (['ollama', 'remote-vlm'].includes(plan.planner) && verification?.verified !== true) return { phase: 'Review required', phaseCode: 'VERIFYING', completionStatus: 'PARTIAL', outcomeVerified: false, message: `The planner stopped with this message: ${message || 'No result provided.'} This result has not been independently verified. Please check the page.` };
  return { phase: 'Complete', phaseCode: 'COMPLETED', completionStatus: 'COMPLETED', outcomeVerified: true, message };
}
// A local model timeout occurs before CAPTAIN has accepted or executed any
// action for this step. Only that fixed, authenticated companion failure may
// trigger one entirely fresh observation/capture/proof and planner request.
// Never reuse a timed-out screenshot, a prior visual proof or an old cN lease.
function retryablePlannerTimeout(response, plan, attempts) {
  return response?.status === 500 && plan?.code === 'MODEL_TIMEOUT' && attempts === 0;
}
async function run(task, tabId, controllerWindowId, requestId) {
  if (running) throw new Error('A CAPTAIN task is already running');
  clearPrivacySession();
  running = true;
  taskAbort = new AbortController();
  const history = [];
  const handoffMetrics = { captchaDetected: false, handoffDuration: 0, resumed: false, taskCompletedAfterHandoff: false };
  const started = performance.now();
  const timeline = [];
  const failedActionSignatures = new Set();
  const approvedPrivacyScopes = new Set();
  let recoveryCount = 0, modelTimeoutRetries = 0, previousContext = null;
  timelineEvent(timeline, started, 'TASK_STARTED', { status: 'OBSERVING' });
  let taskWindowId = controllerWindowId;
  const saveState = value => state({ windowId: taskWindowId, timeline, recoveryCount,
    ...(requestId ? { requestId } : {}), ...value });
  try {
    // User command text is untrusted too. Protect it before any task state,
    // timeline, planner prompt or history receives a copy.
    task = sanitizeCommand(task, { unknownPolicy: 'block' });
    const directNavigation = localDirectNavigation(task);
    const config = await settings();
    // Validate before perception and before the first network request. The
    // server-side sanitizer must never be bypassed by a stored remote URL.
    config.serverUrl = normalizeLoopbackServerUrl(config.serverUrl ?? DEFAULTS.serverUrl);
    const companionToken = await companionAuthToken();
    // Amazon can legitimately require several identity-checked backtracks when
    // a low-price result redirects to a different ASIN. Keep this site-specific
    // recovery bounded without increasing the budget for ordinary commands.
    const taskStepLimit = /\bamazon\b/i.test(task) && /\blaptop(?:s)?\b/i.test(task) ? Math.max(config.maxSteps, 18) : config.maxSteps;
    const amazonFastPath = /\bamazon\b/i.test(task) && /\blaptop(?:s)?\b/i.test(task);
    const observationConfig = { ...config, includeScreenshot: visualObservationEnabled(task, config, amazonFastPath),
      amazonDomFastPath: amazonFastPath, rollingCaptureSamples: ROLLING_CAPTURE_SAMPLES };
    await saveState({ status: 'running', task, phase: 'OBSERVING', history });
    let tab = await resolveTarget(tabId, controllerWindowId);
    if (!tab || tab.incognito) throw new Error('Open CAPTAIN in a normal tab to run commands.');
    taskWindowId = tab.windowId;
    // Recovery already supplies the one requested new tab; do not create two.
    if (/\bin (?:a )?new tab\b/i.test(task) && !tab.captainRecovered) {
      const created = await chrome.tabs.create({ windowId: tab.windowId, url: 'about:blank', active: true });
      await bindTarget(created, tabId);
      tab = created;
    }
    if (chrome.storage.session.set) await bindTarget(tab, tabId);
    await focusTarget(tab);
    // Navigate immediately for an explicit typed site/URL, then perform the
    // normal local observation and privacy scan on the destination. The
    // record lets the companion continue a compound task without trying to
    // infer or repeat this already device-authorized navigation.
    if (directNavigation) {
      checkpoint();
      await saveState({ status: 'running', task, phase: 'NAVIGATING', history });
      timelineEvent(timeline, started, 'ACTION_STARTED', { step: 0, actionType: 'navigate' });
      const navigationStarted = performance.now();
      const navigation = await navigateSameTab(tab.id, directNavigation.url);
      clearPrivacySession();
      history.push({
        action: { type: 'navigate', url: directNavigation.url },
        intent: 'direct-local-navigation', planner: 'local-command',
        reason: 'Navigate to the explicitly typed website before local scanning.',
        result: navigation,
      });
      timelineEvent(timeline, started, 'ACTION_COMPLETED', { step: 0, actionType: 'navigate', status: 'ok', latencyMs: Math.round(performance.now() - navigationStarted) });
      if (Number.isFinite(navigation.navigationMs)) timelineEvent(timeline, started, 'PAGE_NAVIGATION', { step: 0, actionType: 'navigate', latencyMs: navigation.navigationMs });
      tab = await chrome.tabs.get(tab.id);
      if (tab.incognito) throw new Error('CAPTAIN actions require a normal tab.');
      if (!navigation.requiresSignIn && observationConfig.includeScreenshot) {
        const readiness = await waitForPrivacyScanReady(tab);
        timelineEvent(timeline, started, 'PAGE_READY', { step: 0, latencyMs: Math.round(readiness.waitMs) });
      }
    }
    for (let step = 1; step <= taskStepLimit; step++) {
      checkpoint();
      const previousTabUrl = tab.url;
      tab = await chrome.tabs.get(tab.id);
      if (tab.incognito) throw new Error('CAPTAIN actions require a normal tab.');
      // A navigation changes the page privacy boundary. Never carry a private
      // value mapping between documents, even inside the same running task.
      if (previousTabUrl && tab.url !== previousTabUrl) clearPrivacySession();
      timelineEvent(timeline, started, 'SCREEN_CAPTURED', { step });
      let context = await observeStable(tab, observationConfig);
      if (previousContext && (context.url !== previousContext.url ||
        (context.pageMetadata?.documentToken && previousContext.pageMetadata?.documentToken &&
          context.pageMetadata.documentToken !== previousContext.pageMetadata.documentToken))) {
        clearPrivacySession();
      }
      let localLease = mintLocalActionLease(tab, context, step);
      const measured = context.localTiming || {};
      for (const [type, key] of [['PAGE_READY','readinessMs'],['DOM_EXTRACTION','domExtractionMs'],['ACCESSIBILITY_EXTRACTION','accessibilityExtractionMs'],['AMAZON_EXTRACTION','amazonExtractionMs'],['PRIVACY_SCAN','privacyRegionMs'],['SCREEN_CAPTURE','captureMs'],['LOCAL_VISION_REDACTION','localVisionAndRedactionMs'],['PERCEPTION_TOTAL','extensionDomRoundTripMs'],['OCR','ocrMs']]) if (Number.isFinite(measured[key])) timelineEvent(timeline, started, type, { step, latencyMs: measured[key] });
      const change = pageChange(previousContext, context);
      if (history.length && !history.at(-1).pageChange) history.at(-1).pageChange = change;
      timelineEvent(timeline, started, 'PERCEPTION_COMPLETE', { step, pageChange: change });
      previousContext = context;
      checkpoint();
      const piiDetected = Object.values(context.piiCounts || {}).reduce((a, b) => a + b, 0);
      timelineEvent(timeline, started, 'PRIVACY_SCAN_COMPLETE', { step, piiDetected });
      if (context.challenge?.detected) {
        handoffMetrics.captchaDetected = true;
        const handoffStarted = Date.now();
        timelineEvent(timeline, started, 'HUMAN_ACTION_REQUIRED', { step, reasonCode: 'CAPTCHA' });
        await saveState({ status: 'waiting_human', task, phase: 'HUMAN_ACTION_REQUIRED', completionStatus: 'BLOCKED', message: 'Human verification required. Please complete the verification in your browser, then press Resume CAPTAIN.', step, piiDetected, vision: context.vision, history, captchaDetected: true, handoffState: 'WAITING_FOR_HUMAN', resumed: false });
        const handoff = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Human verification timed out after 15 minutes. The task was not resumed.')), 15 * 60 * 1000);
          humanHandoff = { tabId: tab.id, windowId: tab.windowId, resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } };
        });
        humanHandoff = null;
        checkpoint();
        timelineEvent(timeline, started, 'RECOVERY_STARTED', { step, reasonCode: 'HUMAN_VERIFICATION_CLEARED', recoveryCount: recoveryCount + 1 });
        recoveryCount++;
        await saveState({ status: 'running', task, phase: 'RESUMING', phaseCode: 'RECOVERING', message: 'Verification cleared. Re-observing the page locally before resuming.', step, piiDetected, vision: context.vision, history, captchaDetected: true, handoffState: 'VERIFICATION_CLEARED', handoffDuration: Date.now() - handoffStarted, resumed: true });
        // The Resume button only checked that the challenge disappeared.
        // That DOM-only check is not a visual privacy proof or approval.
        tab = await chrome.tabs.get(tab.id);
        context = await observeStable(tab, observationConfig);
        localLease = mintLocalActionLease(tab, context, step);
        handoffMetrics.handoffDuration += Date.now() - handoffStarted;
        handoffMetrics.resumed = true;
        if (context.challenge?.detected) throw new Error('Human verification is still present. CAPTAIN did not resume.');
      }
      // Do not send even a sanitized planning projection until the user has
      // seen the on-page marks and explicitly approved this protected page.
      // Consent is scoped to this document, so a later navigation is checked
      // again while ordinary multi-step work on the same page is not noisy.
      const consentScope = privacyConsentScope(context);
      if (privacyConsentRequired(context, piiDetected) && !approvedPrivacyScopes.has(consentScope)) {
        timelineEvent(timeline, started, 'PRIVACY_CONSENT_REQUIRED', { step, piiDetected });
        await saveState({ status: 'waiting_privacy_consent', task, phase: 'PRIVACY_CONFIRMATION_REQUIRED',
          completionStatus: 'PENDING', outcomeVerified: false,
          message: 'Sensitive information is marked on this page and listed as withheld. Continue without sharing it?',
          step, piiDetected, vision: context.vision, history });
        const choice = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Privacy confirmation timed out after 15 minutes. No information was shared.')), 15 * 60 * 1000);
          privacyApproval = { tabId: tab.id, windowId: tab.windowId,
            resolve: value => { clearTimeout(timer); resolve(value); },
            reject: error => { clearTimeout(timer); reject(error); } };
        });
        privacyApproval = null;
        checkpoint();
        if (choice !== 'continue') {
          timelineEvent(timeline, started, 'PRIVACY_CONSENT_DECLINED', { step });
          await saveState({ status: 'complete', task, phase: 'PRIVACY_DECLINED', completionStatus: 'BLOCKED', outcomeVerified: false,
            message: 'No information was shared. CAPTAIN is ready for another command.', step, piiDetected, vision: context.vision, history });
          return;
        }
        approvedPrivacyScopes.add(consentScope);
        // A person may reasonably take longer than the short action-lease TTL
        // to review the privacy marks. The observation, visual proof and lease
        // from before that pause must never be sent or used after approval.
        // Discard them and restart this *logical* step, so the next payload and
        // action lease come from a new local observation of the current page.
        globalThis.CAPTAIN_ACTION_BINDING?.invalidateTaskBinding(localLease, 'new-observation');
        timelineEvent(timeline, started, 'PRIVACY_CONSENT_GRANTED', { step });
        await saveState({ status: 'running', task, phase: 'REOBSERVING',
          message: 'Privacy confirmation received. Rechecking the page and its privacy protection before continuing.',
          step, piiDetected, vision: context.vision, history });
        // Do not charge the user a planner/action step for this mandatory
        // post-consent re-observation. If the document changed, its different
        // consent scope will require a new local confirmation.
        step--;
        continue;
      }
      await saveState({ status: 'running', task, phase: 'PROTECTING_PRIVACY', step, piiDetected, vision: context.vision, history });
      const payloadStarted = performance.now();
      const payload = JSON.stringify(sanitizePayload({ task: task.replace(/\s+in (?:a )?new tab\b/i, ''), context: plannerContext(context), history }));
      timelineEvent(timeline, started, 'SANITIZATION_PAYLOAD', { step, latencyMs: Math.round(performance.now() - payloadStarted) });
      timelineEvent(timeline, started, 'REQUEST_SENT', { step, provider: 'planner' });
      const requestStarted = performance.now();
      const response = await bounded(fetch(`${config.serverUrl}/api/agent/step`, { signal: taskAbort.signal, method: 'POST',
        headers: { 'content-type': 'application/json', 'x-captain-auth': companionToken }, body: payload }), 100000, 'Planner');
      const plan = await response.json();
      // Remote output is not a license to reintroduce PII to the browser,
      // local UI, or next iteration's history.
      assertNoPrivatePlannerText(plan);
      timelineEvent(timeline, started, 'NETWORK_AND_SERVER', { step, latencyMs: Math.round(performance.now() - requestStarted) });
      if (plan.serverTiming) {
        timelineEvent(timeline, started, 'SERVER_RECEIVE_PARSE', { step, latencyMs: plan.serverTiming.bodyParseMs || 0 });
        timelineEvent(timeline, started, 'SERVER_PRIVACY_BOUNDARY', { step, latencyMs: plan.serverTiming.privacyBoundaryMs || 0 });
        timelineEvent(timeline, started, 'PLANNER', { step, latencyMs: plan.serverTiming.plannerMs || 0, provider: plan.planner || 'unknown' });
      }
      if (!response.ok) {
        if (retryablePlannerTimeout(response, plan, modelTimeoutRetries)) {
          // No model action was validated or executed. The next loop iteration
          // must redo the entire privacy path and mint a NEW action lease.
          checkpoint();
          modelTimeoutRetries++;
          globalThis.CAPTAIN_ACTION_BINDING?.invalidateTaskBinding(localLease, 'new-observation');
          timelineEvent(timeline, started, 'RECOVERY_STARTED', { step, reasonCode: 'MODEL_TIMEOUT', recoveryCount: modelTimeoutRetries });
          await saveState({ status: 'running', task, phase: 'RECOVERING',
            message: 'The local planner timed out before acting. Rechecking the page and its privacy protection once.',
            step, piiDetected, vision: context.vision, history });
          continue;
        }
        const category = ['MODEL_EMPTY','MODEL_JSON_INVALID','MODEL_ACTION_INVALID',
          'MODEL_TIMEOUT','MODEL_UNAVAILABLE','PLANNER_FAILED'].includes(plan.code) ? plan.code : null;
        const providerStatus = category === 'MODEL_UNAVAILABLE' &&
          Number.isInteger(plan.providerStatus) && plan.providerStatus >= 100 &&
          plan.providerStatus <= 599 ? ` HTTP ${plan.providerStatus}${['memory','context','image','request','model','unknown'].includes(plan.providerKind) ? ` ${plan.providerKind}` : ''}` : '';
        const failure = new Error(`${plan.error || `Agent server error ${response.status}`}${category ? ` (${category}${providerStatus})` :
          plan.categories ? ` (${plan.categories.join(', ')})` : ''}`);
        // The local companion returns these only after authenticating the
        // extension, and both strings are server-side schema constants. Keep
        // them out of the UI while allowing safe diagnosis of contract drift.
        if (plan.code === 'CAPTAIN_OUTBOUND_CONTRACT' &&
          typeof plan.contractPath === 'string' && /^[A-Za-z0-9_.\[\]]{1,160}$/.test(plan.contractPath) &&
          typeof plan.contractReason === 'string' && /^[a-z-]{2,40}(?: [a-z-]{2,40}){0,4}$/.test(plan.contractReason)) {
          failure.captainContractDiagnostic = { path: plan.contractPath, reason: plan.contractReason };
        }
        throw failure;
      }
      checkpoint();
      // A protected credential or identity field must never be operated by the
      // planner. End this command and ask the person in control what to do.
      if (actionNeedsSensitiveAccess(plan.action, context.elements || [])) {
        timelineEvent(timeline, started, 'SENSITIVE_ACCESS_REQUIRED', { step, actionType: plan.action?.type || 'unknown' });
        await saveState({ status: 'complete', task, phase: 'SENSITIVE_ACCESS_REQUIRED', completionStatus: 'BLOCKED', outcomeVerified: false,
          message: SENSITIVE_ACCESS_REQUIRED_MESSAGE, requiresInput: true, followUpPrefix: '',
          step, piiDetected, vision: context.vision, history });
        return;
      }
      // Enforce locally before persisting planner output or sending an action
      // to the page. A malicious/buggy server cannot type or submit credentials.
      await validatePlannedActionOnDevice(plan, context, tab, localLease);
      enforceActionPrivacy(plan.action, context.elements || []);
      timelineEvent(timeline, started, 'PLAN_RECEIVED', { step, provider: plan.planner || 'unknown', model: plan.model || '' });
      const actionSignature = JSON.stringify({ type: plan.action.type, target: plan.action.target?.ref, value: plan.action.value, url: plan.action.url });
      if (failedActionSignatures.has(actionSignature)) throw new Error('No progress: the planner repeated the same failed action after recovery.');
      timelineEvent(timeline, started, 'ACTION_STARTED', { step, actionType: plan.action.type });
      const actionStarted = performance.now();
      await saveState({ status: 'running', task, phase: 'EXECUTING', step, piiDetected,
        history: [...history, plannerHistoryEntry(plan)] });
      let result;
      if (plan.action.type === 'media' && plan.action.operation === 'play') {
        // Chrome may defer playback while a tab is hidden without rejecting play().
        await focusTarget(tab);
        checkpoint();
      }
      if (plan.action.type === 'finish') result = { ok: true, done: true, message: plan.action.message };
      else if (plan.action.type === 'navigate') result = await navigateSameTab(tab.id, plan.action.url);
      else if (plan.action.type === 'back') result = await backSameTab(tab.id);
      else {
        result = await send(tab.id, { type: 'EXECUTE', action: plan.action,
          ...(localLease.executionGuard ? { observationGuard: localLease.executionGuard } : {}) });
        assertNoPrivatePlannerText(result);
        if (result.navigateUrl) result = await navigateSameTab(tab.id, result.navigateUrl, { searchValue: result.expectedSearchValue });
        if (result.requiresPlayClick) {
          await trustedPlayClick(tab, result.requiresPlayClick);
          result = { ok: true, pending: 'Play clicked; verifying playback on next observation' };
        }
      }
      if (result.navigated) clearPrivacySession();
      globalThis.CAPTAIN_ACTION_BINDING?.invalidateTaskBinding(localLease, 'new-observation');
      history.push(plannerHistoryEntry(plan, result));
      timelineEvent(timeline, started, 'ACTION_COMPLETED', { step, actionType: plan.action.type, status: result.ok ? 'ok' : 'failed', latencyMs: Math.round(performance.now() - actionStarted) });
      if (Number.isFinite(result.navigationMs)) timelineEvent(timeline, started, 'PAGE_NAVIGATION', { step, actionType: plan.action.type, latencyMs: result.navigationMs });
      if (plan.action.type === 'finish' || result.done) {
        if (!plan.action.clarification && plan.action.verification?.type === 'playback') {
          await focusTarget(tab);
          timelineEvent(timeline, started, 'VERIFICATION_STARTED', { step });
          const verification = await verifyRequestedPlayback(tab, plan.action.verification.query || '', message => saveState({ status: 'running', task, phase: 'VERIFYING', message, step, piiDetected, history }));
          history[history.length - 1].verification = verification;
        }
        checkpoint();
        const latencyMs = Math.round(performance.now() - started);
        handoffMetrics.taskCompletedAfterHandoff = handoffMetrics.resumed;
        const completion = completionSummary(plan, result, history[history.length - 1].verification, history);
        timelineEvent(timeline, started, completion.completionStatus === 'COMPLETED' ? 'TASK_COMPLETED' : 'TASK_PARTIAL', { step, status: completion.completionStatus, latencyMs });
        await saveState({ status: 'complete', task, ...completion, requiresInput: !!plan.action.clarification, followUpPrefix: plan.action.followUpPrefix || '', step, piiDetected, vision: context.vision, latencyMs, history, ...handoffMetrics });
        fetch(`${config.serverUrl}/api/metrics`, { method: 'POST',
          headers: { 'content-type': 'application/json', 'x-captain-auth': companionToken },
          body: JSON.stringify(metricProjection(latencyMs, piiDetected, step, context.vision)) }).catch(() => {});
        return;
      }
      if (!result.ok) {
        const recoverable = recoveryCount < 2 && (result.retryable || /target not found|stale|changed while executing/i.test(result.error || ''));
        if (!recoverable) throw new Error(result.error);
        failedActionSignatures.add(actionSignature); recoveryCount++;
        timelineEvent(timeline, started, 'RECOVERY_STARTED', { step, reasonCode: /target not found/i.test(result.error || '') ? 'ELEMENT_NOT_FOUND' : 'STALE_ELEMENT', recoveryCount });
        await saveState({ status: 'running', task, phase: 'RECOVERING', message: 'The page changed. Re-observing before choosing another grounded action.', step, piiDetected, history });
        await new Promise(resolve => setTimeout(resolve, 500 * recoveryCount));
        continue;
      }
      // Scrolling updates geometry immediately; a short paint-settle delay keeps
      // the action loop responsive without weakening navigation/click waits.
      const settleMs = amazonFastPath
        ? result.navigated ? 80 : plan.action.type === 'scroll' ? 100 : plan.action.type === 'wait' ? 0 : plan.action.type === 'select' ? 200 : 80
        : result.navigated ? 1800 : plan.action.type === 'scroll' ? 250 : 900;
      const settleStarted = performance.now();
      await new Promise((r) => setTimeout(r, settleMs));
      timelineEvent(timeline, started, 'PAGE_STABLE_WAIT', { step, latencyMs: Math.round(performance.now() - settleStarted) });
      tab = await chrome.tabs.get(tab.id);
    }
    throw new Error(`Stopped after ${taskStepLimit} steps`);
  } catch (error) {
    timelineEvent(timeline, started, 'TASK_FAILED', { status: taskAbort?.signal.aborted ? 'CANCELLED' : 'FAILED' });
    await saveState({ status: 'error', task, phase: taskAbort?.signal.aborted ? 'Cancelled' : 'Stopped', phaseCode: taskAbort?.signal.aborted ? 'CANCELLED' : 'FAILED', completionStatus: 'FAILED', message: taskAbort?.signal.aborted ? 'Cancelled. No further actions will be sent; an action already sent cannot be undone.' : error.message, history,
      ...(typeof error?.captainVisualStage === 'string' ? { visualStage: error.captainVisualStage } : {}),
      ...(typeof error?.captainVisualReason === 'string' ? { visualReason: error.captainVisualReason } : {}),
      ...(error?.captainContractDiagnostic ? { contractDiagnostic: error.captainContractDiagnostic } : {}), ...handoffMetrics });
  }
  finally { humanHandoff = null; privacyApproval = null; clearPrivacySession(); taskAbort = null; running = false; }
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message.type === 'CAPTURE_LOCAL_PREVIEW') {
    if (running || localPreviewBusy) { respond({ ok: false, busy: true }); return false; }
    if (!sender.tab || sender.frameId !== 0 && sender.frameId !== undefined || sender.tab.incognito) {
      respond({ ok: false }); return false;
    }
    localPreviewBusy = true;
    (async () => {
      try {
        const tab = await chrome.tabs.get(sender.tab.id);
        const count = await captureLocalFieldPreview(tab);
        respond({ ok: true, count, localOnly: true });
      } catch { respond({ ok: false, error: 'Page changed or capture unavailable. Hold E to retry.' }); }
      finally { localPreviewBusy = false; }
    })();
    return true;
  }
  if (message.type === 'CANCEL_TASK') { taskAbort?.abort(); clearPrivacySession(); humanHandoff?.reject(new Error('Task cancelled during human verification.')); humanHandoff = null; privacyApproval?.reject(new Error('Task cancelled during privacy confirmation.')); privacyApproval = null; respond({ ok: true, running }); return; }
  if (message.type === 'PRIVACY_CONTINUE' || message.type === 'PRIVACY_STOP') {
    (async () => {
      if (!privacyApproval) return { ok: false, error: 'CAPTAIN is not waiting for privacy confirmation.' };
      const tab = await chrome.tabs.get(privacyApproval.tabId);
      if (tab.incognito || tab.windowId !== privacyApproval.windowId)
        return { ok: false, error: 'The confirmation tab moved or is no longer a normal CAPTAIN tab.' };
      const approval = privacyApproval; privacyApproval = null;
      approval.resolve(message.type === 'PRIVACY_CONTINUE' ? 'continue' : 'stop');
      return { ok: true, choice: message.type === 'PRIVACY_CONTINUE' ? 'continue' : 'stop' };
    })().then(respond, error => respond({ ok: false, error: error.message }));
    return true;
  }
  if (message.type === 'RESUME_TASK') {
    (async () => {
      if (!humanHandoff) return { ok: false, error: 'CAPTAIN is not waiting for human verification.' };
      const tab = await chrome.tabs.get(humanHandoff.tabId);
      if (tab.incognito || tab.windowId !== humanHandoff.windowId) return { ok: false, error: 'The verification tab moved or is no longer a normal CAPTAIN tab.' };
      const context = await send(tab.id, { type: 'OBSERVE' });
      if (!context || context.error || (chrome.runtime?.id && !completePerceptionLease(perceptionLease(context))))
        throw new Error('Local observation failed; page information withheld.');
      if (context.challenge?.detected) return { ok: false, error: 'Human verification is still visible. Complete it before resuming CAPTAIN.' };
      const handoff = humanHandoff; humanHandoff = null; handoff.resolve({ context });
      return { ok: true, handoffState: 'VERIFICATION_CLEARED' };
    })().then(respond, error => respond({ ok: false, error: error.message }));
    return true;
  }
  if (message.type === 'START_TASK') {
    if (localPreviewBusy) { respond({ ok: false, error: 'Local capture is finishing. Retry shortly.' }); return; }
    if (running) { respond({ ok: false, error: 'A task is already running.' }); return; }
    if (typeof message.task !== 'string' || !message.task.trim()) { respond({ ok: false, error: 'Enter a command.' }); return; }
    const fromController = sender.url?.startsWith(chrome.runtime.getURL('popup.html'));
    const targetId = fromController ? message.tabId : sender.tab?.id;
    // Keep early failures (including missing companion authentication) visible
    // in the originating page's window before target resolution has run.
    const controllerWindowId = sender.tab?.windowId;
    const requestId = typeof message.requestId === 'string' && /^text-[a-z0-9]{1,16}-[a-z0-9]{1,10}$/.test(message.requestId) ? message.requestId : undefined;
    run(message.task, targetId, controllerWindowId, requestId).catch(error => state({ status: 'error', message: error.message }));
    respond({ ok: true });
  }
  if (message.type === 'GET_STATE') {
    (async () => {
      const saved = (await chrome.storage.local.get('captainState')).captainState;
      const windowId = sender.tab?.windowId;
      const originId = sender.url?.startsWith(chrome.runtime.getURL('popup.html')) ? Number(new URL(sender.url).searchParams.get('target')) || undefined : sender.tab?.id;
      const value = saved && (!windowId || saved.windowId === windowId) ? saved : { status: 'idle' };
      respond({ ...value, build: CAPTAIN_BUILD, session: await sessionTarget(windowId, originId) });
    })().catch(error => respond({ status: 'error', message: error.message, build: CAPTAIN_BUILD }));
    return true;
  }
});
