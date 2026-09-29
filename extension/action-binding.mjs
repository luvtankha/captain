// Device-owned action lease. Never construct taskBinding or freshObservation from
// a planner response, page script, or untrusted request body.
export const ACTION_BINDING_TTL_MS = 120_000;

const ACTION_TYPES = new Set([
  'click', 'hover', 'type', 'press', 'select', 'submit', 'request_local_input',
  'navigate', 'back', 'scroll', 'wait', 'media', 'finish'
]);
const TARGET_REQUIRED = new Set(['click', 'hover', 'type', 'press', 'select', 'submit', 'request_local_input']);
const REMOTE_VALUE_ACTIONS = new Set(['type', 'select', 'press', 'submit']);
const LOCAL_INPUT_TYPES = new Set(['password', 'otp', 'pin', 'cvv', 'card', 'token', 'api-key', 'secret', 'security-answer']);
const CONSEQUENTIAL = /\b(?:buy(?:\s+now)?|purchase|place\s+order|checkout|pay(?:ment)?|transfer|send(?:\s+(?:message|email|money))?|post|publish|delete|erase|remove\s+account|unsubscribe|cancel\s+(?:subscription|order)|accept|agree|consent|terms|authorize|confirm|save(?:\s+changes)?|book|reserve|submit(?:\s+application)?|sign|upload|download)\b/i;
const HIGH_RISK = /\b(?:buy|purchase|place\s+order|checkout|pay(?:ment)?|transfer|send|post|publish|delete|erase|remove|unsubscribe|cancel|accept|agree|consent|terms|authorize|confirm|save|book|reserve|sign|upload|download)\b/i;
const SEARCH = /\b(?:search|find|query)\b/i;
const BINDING_FIELDS = ['tabId', 'windowId', 'frameId', 'origin', 'documentGeneration', 'observationId', 'createdMonotonicMs', 'navigationEpoch'];

function assert(condition, message) {
  if (!condition) throw new Error(`Action binding rejected: ${message}`);
}

function positiveId(value) { return Number.isSafeInteger(value) && value > 0; }
function nonnegativeId(value) { return Number.isSafeInteger(value) && value >= 0; }
function generation(value) {
  return (typeof value === 'string' && value.length > 0 && value.length <= 128) || nonnegativeId(value);
}
function actualOrigin(url) {
  try {
    if (url === 'about:blank') return 'null';
    const parsed = new URL(url);
    return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password ? parsed.origin : null;
  } catch { return null; }
}
function searchField(target) {
  const description = [target?.name, target?.placeholder, target?.groupText, target?.href].filter(Boolean).join(' ');
  // A page can label a payment or deletion form "search"; semantics alone
  // must not exempt it from confirmation when risk is observable.
  return !HIGH_RISK.test(description) && (target?.type === 'search' || target?.role === 'searchbox'
    || SEARCH.test(description));
}
function sensitiveTarget(target) {
  if (!target || target.sensitive !== false) return true; // Unknown metadata fails closed.
  const hints = [target.type, target.sensitiveType, target.name, target.placeholder].filter(Boolean).join(' ');
  return /\b(?:password|passcode|one[-\s]?time|otp|cvv|cvc|pin|card(?:\s+number)?|credit|debit|api[-\s]?key|access[-\s]?token|secret|security[-\s]?answer)\b/i.test(hints);
}
function consequentialNavigation(rawUrl) {
  const url = new URL(rawUrl);
  let route;
  try { route = decodeURIComponent(url.pathname + url.hash); }
  catch { return true; }
  // Double encoding can conceal a consequential segment until a later layer.
  if (/%[0-9a-f]{2}/i.test(route)) return true;
  const readable = route.replace(/([a-z])([A-Z])/g, '$1 $2');
  if (HIGH_RISK.test(readable) || /\bsubmit\b/i.test(readable)) return true;
  for (const [key, value] of url.searchParams) {
    if (HIGH_RISK.test(key)) return true;
    if (/^(?:action|do|op|operation|command|event|mode|step)$/i.test(key)
      && HIGH_RISK.test(value)) return true;
  }
  return false;
}
function consequentialAction(action, target) {
  if (action.type === 'submit') return !searchField(target);
  if (action.type === 'press' && action.key === 'Enter') return !searchField(target);
  if (action.type === 'type' && action.submit) return !searchField(target);
  const label = [target?.name, target?.text, target?.groupText, target?.placeholder, target?.href, target?.type].filter(Boolean).join(' ');
  if (TARGET_REQUIRED.has(action.type) && CONSEQUENTIAL.test(label)) return true;
  if (action.type === 'click' && !label.trim()) return true; // Unknown icon/button.
  if (action.type === 'navigate') {
    return consequentialNavigation(action.url);
  }
  return false;
}

/**
 * Validate a planner action against an observation lease minted in the device
 * runtime. All identifiers are owned by the extension; an echoed planner ID
 * may narrow the match but cannot establish trust. Failures throw before action.
 *
 * freshObservation: { tabId, windowId, frameId, origin, url,
 *   documentGeneration, observationId, createdMonotonicMs, navigationEpoch,
 *   elements: [{ ref: 'c1', sensitive, ... }] }
 * taskBinding: same lease identity fields, ttlMs, optional nowMonotonicMs,
 *   optional abortSignal, and optional locally approved confirmation.
 *
 * Return: { action, target, observationId }; target is from the local
 * observation, never the planner-supplied target object.
 */
export function validateActionOnDevice(plan, freshObservation, taskBinding) {
  assert(plan && typeof plan === 'object', 'missing plan');
  const action = plan.action ?? plan; // Existing CAPTAIN plan or direct action.
  assert(action && typeof action === 'object' && !Array.isArray(action), 'invalid action');
  assert(ACTION_TYPES.has(action.type), 'unsupported action type; local review is required before adding a new executor');
  assert(freshObservation && typeof freshObservation === 'object', 'missing fresh device observation');
  assert(taskBinding && typeof taskBinding === 'object', 'missing device task binding');

  assert(!taskBinding.invalidated && taskBinding.active !== false
    && !taskBinding.cancelled && !taskBinding.reloaded && !taskBinding.navigationPending
    && !taskBinding.abortSignal?.aborted && !freshObservation.invalidated
    && !freshObservation.cancelled && !freshObservation.reloaded
    && !freshObservation.navigationPending, 'task cancelled or observation invalidated');

  assert(positiveId(taskBinding.tabId) && positiveId(taskBinding.windowId)
    && nonnegativeId(taskBinding.frameId), 'invalid tab/window/frame identity');
  assert(typeof taskBinding.origin === 'string' && taskBinding.origin.length > 0
    && typeof taskBinding.url === 'string' && taskBinding.url.length > 0
    && generation(taskBinding.documentGeneration)
    && typeof taskBinding.observationId === 'string'
    && taskBinding.observationId.length > 0 && taskBinding.observationId.length <= 128
    && nonnegativeId(taskBinding.navigationEpoch)
    && Number.isFinite(taskBinding.createdMonotonicMs) && taskBinding.createdMonotonicMs >= 0,
  'incomplete observation lease');
  for (const field of BINDING_FIELDS) {
    assert(Object.hasOwn(freshObservation, field) && freshObservation[field] === taskBinding[field],
      `stale or mismatched ${field}`);
  }
  assert(actualOrigin(freshObservation.url) === taskBinding.origin,
    'observed URL/origin changed');
  assert(taskBinding.url === freshObservation.url, 'observed URL changed');

  // Optional planner echoes cannot supersede the locally minted lease.
  for (const field of BINDING_FIELDS) {
    if (Object.hasOwn(plan, field)) assert(plan[field] === taskBinding[field], `plan ${field} mismatch`);
    if (Object.hasOwn(action, field)) assert(action[field] === taskBinding[field], `action ${field} mismatch`);
  }
  const ttl = taskBinding.ttlMs;
  assert(Number.isFinite(ttl) && ttl > 0 && ttl <= ACTION_BINDING_TTL_MS, 'invalid TTL');
  const now = taskBinding.nowMonotonicMs ?? globalThis.performance?.now?.();
  assert(Number.isFinite(now) && now >= taskBinding.createdMonotonicMs
    && now - taskBinding.createdMonotonicMs <= ttl, 'observation lease expired or clock changed');

  const ref = action.target?.ref;
  assert(ref === undefined || /^c[1-9]\d*$/.test(ref), 'invalid observed local cN reference');
  assert(!TARGET_REQUIRED.has(action.type) || typeof ref === 'string', 'action requires an observed local cN reference');
  const elements = freshObservation.elements;
  assert(Array.isArray(elements), 'missing local observed controls');
  const target = ref === undefined ? null : elements.find(element => element?.ref === ref);
  assert(ref === undefined || !!target, 'target absent from fresh observation');
  assert(!target?.disabled && !target?.state?.disabled, 'target disabled');
  // Any target identity echoed by a planner must agree with the locally observed element.
  if (action.target) for (const field of ['tabId', 'windowId', 'frameId', 'origin', 'documentGeneration', 'observationId']) {
    if (Object.hasOwn(action.target, field)) assert(action.target[field] === taskBinding[field], `target ${field} mismatch`);
  }
  if (REMOTE_VALUE_ACTIONS.has(action.type)) {
    assert(!sensitiveTarget(target), 'remote control of sensitive field blocked; use local secure input');
  }
  if (action.type === 'request_local_input') {
    assert(target?.sensitive, 'local secure input requires an observed sensitive field');
    assert(LOCAL_INPUT_TYPES.has(action.inputType), 'unsupported local input type');
    // Prevent alternate model-defined payload names from reaching history/UI.
    const permitted = new Set(['type', 'target', 'inputType', ...BINDING_FIELDS]);
    assert(Reflect.ownKeys(action).every(key => typeof key === 'string' && permitted.has(key))
      && action.target && typeof action.target === 'object'
      && Reflect.ownKeys(action.target).every(key => typeof key === 'string'
        && (key === 'ref' || BINDING_FIELDS.includes(key))),
    'local input request must not contain a credential value or extra fields');
  }
  if (['type', 'select'].includes(action.type)) assert(typeof action.value === 'string', 'action value must be text');
  if (action.type === 'navigate') {
    assert(actualOrigin(action.url) && actualOrigin(action.url) !== 'null', 'unsupported navigation URL');
  }
  if (action.type === 'media') assert(['play', 'pause'].includes(action.operation), 'unsupported media operation');
  if (action.type === 'scroll') assert(['up', 'down'].includes(action.direction)
    && (action.amount === undefined || Number.isFinite(action.amount) && action.amount >= 0 && action.amount <= 10000),
  'invalid scroll operation');
  if (action.type === 'wait') assert(action.ms === undefined
    || Number.isFinite(action.ms) && action.ms >= 0 && action.ms <= 3000, 'invalid wait interval');

  if (consequentialAction(action, target)) {
    const approval = taskBinding.confirmation;
    assert(approval?.approved === true && approval.confirmedByLocalUser === true
      && approval.consumed !== true && approval.action === action
      && approval.actionSnapshot === JSON.stringify(action)
      && approval.observationId === taskBinding.observationId
      && approval.documentGeneration === taskBinding.documentGeneration
      && Number.isFinite(approval.confirmedAtMonotonicMs)
      && approval.confirmedAtMonotonicMs >= taskBinding.createdMonotonicMs
      && approval.confirmedAtMonotonicMs <= now,
    'consequential action requires fresh local user confirmation');
    approval.consumed = true; // A confirmation authorizes one action once.
  }
  return { action, target: target || null, observationId: taskBinding.observationId };
}

/** Mark the locally held lease unusable on navigation, reload, cancel or handoff. */
export function invalidateTaskBinding(taskBinding, reason = 'other') {
  assert(taskBinding && typeof taskBinding === 'object', 'missing device task binding');
  taskBinding.invalidated = true;
  taskBinding.invalidatedReason = ['navigation', 'reload', 'cancel', 'tab-closed', 'frame-detached', 'new-observation', 'timeout'].includes(reason) ? reason : 'other';
  if (taskBinding.confirmation) taskBinding.confirmation.consumed = true;
  return taskBinding;
}
