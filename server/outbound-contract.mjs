import { createHash } from 'node:crypto';
import { scanText } from './privacy.mjs';

export const OBSERVATION_SCHEMA = 'captain.observation.v2';
export const SANITIZED_SCHEMA = 'captain.sanitized.v2';
export const VISUAL_PRIVACY_SCHEMA = 'captain.visual-privacy.v2';
export const AUDIT_SCHEMA = 'captain.audit.v1';
export const ACTION_SCHEMA = 'captain.action.v2';

const LEGACY_VISUAL_SCHEMA = 'captain.visual-privacy.v1';
const MODEL_SHA256 = 'd7c687949526065ab6a192fdf993360045ce27b0fabf7c9fca5c2437b786b495';
const MAX_IMAGE_BYTES = 2_500_000;
const MAX_JSON_BYTES = 4_500_000;
const MAX_HISTORY = 20;
const HAS_OWN = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

function reject(path, reason = 'invalid field') {
  // Do not echo field contents, URLs, prompts, or other untrusted user data.
  const error = new TypeError(`Outbound contract rejected ${path}: ${reason}`);
  error.code = 'CAPTAIN_OUTBOUND_CONTRACT';
  error.status = 422;
  throw error;
}

function plain(value, path) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) reject(path, 'expected plain object');
  return value;
}

function shape(fields, required = []) {
  return (value, path) => {
    plain(value, path);
    const output = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string' || !HAS_OWN(fields, key)) reject(path, 'unexpected field');
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !HAS_OWN(descriptor, 'value')) reject(path, 'accessor field');
      if (descriptor.value === undefined) reject(path, 'undefined field');
      output[key] = fields[key](descriptor.value, `${path}.${key}`);
    }
    for (const key of required) if (!HAS_OWN(output, key)) reject(path, 'missing required field');
    return output;
  };
}

function arr(item, max) {
  return (value, path) => {
    if (!Array.isArray(value) || value.length > max) reject(path, 'invalid array size');
    const output = [];
    for (let i = 0; i < value.length; i++) {
      if (!HAS_OWN(value, i)) reject(path, 'sparse array');
      output.push(item(value[i], `${path}[${i}]`));
    }
    if (Reflect.ownKeys(value).some(key => key !== 'length' && (!/^(?:0|[1-9]\d*)$/.test(String(key)) || Number(key) >= value.length))) reject(path, 'unexpected array property');
    return output;
  };
}

function nullable(check) { return (value, path) => value === null ? null : check(value, path); }
function constant(expected) { return (value, path) => value === expected ? value : reject(path, 'unexpected value'); }
function oneOf(...allowed) { return (value, path) => allowed.includes(value) ? value : reject(path, 'unexpected value'); }
function number(min = 0, max = 1_000_000_000) {
  return (value, path) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
    ? value : reject(path, 'out-of-range number');
}
function boolean(value, path) { return typeof value === 'boolean' ? value : reject(path, 'expected boolean'); }

function text(max = 300, pattern) {
  return (value, path) => {
    if (typeof value !== 'string' || value.length > max ||
      /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value) ||
      /\bCANARY(?:[_\s:-]|$)|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bBearer\s+\S+|\bsk-[A-Za-z0-9_-]{12,}|\bdata:(?:image|application)\//i.test(value) ||
      scanText(value).length || (pattern && !pattern.test(value))) reject(path, 'unsafe or oversized text');
    // URL-bearing text may contain a disguised query, fragment, or credential.
    const urls = value.match(/https?:\/\/[^\s<>"']+/gi) || [];
    for (const candidate of urls) checkUrl(candidate.replace(/[),.;]+$/, ''), path);
    return value;
  };
}
function digest(value, path) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : reject(path, 'invalid digest');
}
function shortHash(value, path) {
  return typeof value === 'string' && /^[a-f0-9]{8}$/.test(value) ? value : reject(path, 'invalid fingerprint');
}
function checkUrl(value, path) {
  if (typeof value !== 'string' || value.length > 1024 || /[\s\x00-\x1f\\]/.test(value)) reject(path, 'invalid URL');
  if (value === 'about:blank') return value;
  let url;
  try { url = new URL(value); } catch { reject(path, 'invalid URL'); }
  if (!['https:', 'http:'].includes(url.protocol) || !url.hostname || url.username || url.password ||
    value.includes('?') || value.includes('#') || /%(?:25|3f|23|40)/i.test(value) || /(?:^|\/)\.\.(?:\/|$)/.test(url.pathname)) reject(path, 'unsafe URL');
  let decoded;
  try { decoded = decodeURIComponent(url.pathname); } catch { reject(path, 'invalid URL encoding'); }
  if (scanText(decoded).length || /\bCANARY(?:[_\s:-]|$)/i.test(decoded) || /[?#@\x00-\x1f]/.test(decoded)) reject(path, 'unsafe URL path');
  return value;
}
function url(value, path) { return checkUrl(value, path); }
function optionalUrl(value, path) { return value === '' ? '' : checkUrl(value, path); }
function ref(value, path) { return typeof value === 'string' && /^c[1-9]\d{0,4}$/.test(value) ? value : reject(path, 'invalid element reference'); }
function asin(value, path) { return typeof value === 'string' && (/^[A-Z0-9]{10}$/.test(value) || value === '') ? value : reject(path, 'invalid product identifier'); }
function counts(value, path) {
  plain(value, path);
  const result = {};
  const allowed = new Set([
    'email','phone','card','aadhaar','pan','secret','password','otp','pin','cvv','token','api-key','security-answer',
    'SECRET','EMAIL','PHONE','CARD','AADHAAR','PAN','PII','RASTER_CONTENT','BACKGROUND_IMAGE',
    'NAME','FULL_NAME','ADDRESS','DATE_OF_BIRTH','DOB','PASSPORT','PASSPORT_NUMBER',
    'ACCOUNT','ACCOUNT_NUMBER','IFSC',
    // Phase-03 canonical detector types. These are category-only counts, never
    // raw values, and are discarded after strict validation at the gateway.
    'API_KEY','TOKEN','PASSWORD','OTP','PIN','CREDENTIAL','PERSON','UNKNOWN'
  ]);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.has(key)) reject(path, 'unknown counter');
    result[key] = number(0, 100_000)(value[key], `${path}.${key}`);
  }
  return result;
}

const bbox = shape({ x: number(-100_000, 100_000), y: number(-100_000, 100_000), width: number(0, 100_000), height: number(0, 100_000) }, ['x','y','width','height']);
const option = shape({ text: text(120), value: text(180), selected: boolean });
const elementState = shape({ checked: boolean, selected: nullable(number(-1, 100_000)), expanded: nullable(text(24)), readonly: boolean, options: arr(option, 60) });
const element = shape({
  ref, tag: text(32), role: text(80), type: text(40), name: text(500), text: text(500),
  value: text(500), placeholder: text(240), groupText: text(500), href: optionalUrl, disabled: boolean,
  // Phase-02 accessibility fields are individually length- and PII-checked;
  // page-local document tokens/revisions are intentionally not accepted here.
  accessibleName: text(240), associatedLabel: text(240), ariaLabel: text(240),
  autocomplete: text(80), inputMode: text(40), nearbyText: text(180),
  framePath: text(80, /^top(?:\/(?:shadow|frame)[1-9]\d*){0,8}$/),
  visible: boolean, enabled: boolean,
  sensitive: boolean, sensitiveType: text(48), bbox, state: elementState,
  confidence: number(0, 1), source: oneOf('dom','text','vision','fused','AMAZON_SEMANTIC_DOM')
}, ['ref']);
function safeElement(value, path) {
  const projected = element(value, path);
  if (projected.sensitive === true) {
    // Legacy generic masks and canonical Phase-03 typed placeholders are
    // accepted. An UNKNOWN placeholder is never evidence of safe detection.
    if (projected.value && !/^\[(?:REDACTED_(?!UNKNOWN\b)[A-Z_]+|(?:EMAIL|PHONE|PAN|AADHAAR|CARD|API_KEY|TOKEN|PASSWORD|OTP|PIN|CREDENTIAL|PERSON|ADDRESS|ACCOUNT)_[1-9]\d{0,4})\]$/.test(projected.value)) reject(path, 'sensitive value not redacted');
    if (projected.state?.options?.length) reject(path, 'sensitive options not redacted');
  }
  return projected;
}
const region = shape({
  id: text(24), role: text(80), text: text(300), bbox, state: shape({}), confidence: number(0, 1),
  source: oneOf('DOM','OCR','VISION','FUSED','VISION_GEOMETRY')
});
const sensitiveRegion = shape({ id: text(24), type: text(40), bbox, confidence: number(0, 1), source: oneOf('DOM_PRIVACY','OCR','VISION') });
const product = shape({
  asin, title: text(240), price: nullable(number(0, 100_000_000)), currency: oneOf('','INR'),
  rating: nullable(number(0, 5)), ratingCount: nullable(number(0, 100_000_000)),
  url: optionalUrl, availability: text(100), sponsored: boolean, position: number(0, 100_000),
  confidence: number(0, 1), ref, bbox
});
const productDetail = shape({ asin, title: text(240), price: nullable(number(0, 100_000_000)), currency: oneOf('','INR'), url: optionalUrl });
const searchResult = shape({ ref, title: text(240), href: url, source: oneOf('displayed-origin'), ad: boolean, isAd: boolean, sponsored: boolean });
const media = shape({
  paused: boolean, ended: boolean, readyState: number(0, 4), networkState: number(0, 3),
  currentTime: number(0, 1_000_000_000), visible: boolean, pageVisible: boolean,
  error: nullable(shape({
    code: number(0, 4),
    message: oneOf('Media loading was aborted.','The player could not download its media.','The browser could not decode this media.','This media format or source is unavailable.','The media player reported an error.')
  }, ['code','message'])), primary: boolean
});
const visualProof = shape({
  schema: constant(VISUAL_PRIVACY_SCHEMA), sanitized: constant(true), rawScreenshotTransmitted: constant(false),
  redactionApplied: constant(true), domBoxes: number(0, 100_000), faces: number(0, 100_000),
  inferenceMs: number(), totalMs: number(), outputBytes: number(100, MAX_IMAGE_BYTES),
  faceModel: constant('ultraface-rfb-320'), modelSha256: constant(MODEL_SHA256), imageSha256: digest,
  migratedFrom: constant(LEGACY_VISUAL_SCHEMA),
  // Phase-04 native worker proof. These fields are deliberately not synthesized
  // during v1 migration: a legacy digest is not evidence of opaque pixel masking.
  maskPolicy: constant('opaque-raster-v1'), coverageVerified: constant(true),
  pixelMaskCount: number(1, 100_000), fullBlackout: boolean,
  input: shape({ width: number(1, 100_000), height: number(1, 100_000) }, ['width','height'])
}, ['schema','sanitized','rawScreenshotTransmitted','redactionApplied','domBoxes','faces','inferenceMs','totalMs','outputBytes','faceModel','modelSha256','imageSha256']);
const oldProof = shape({
  schema: constant(LEGACY_VISUAL_SCHEMA), sanitized: constant(true), rawScreenshotTransmitted: constant(false),
  redactionApplied: constant(true), domBoxes: number(0, 100_000), faces: number(0, 100_000),
  faceMaxConfidence: number(0, 1), inferenceMs: number(), totalMs: number(),
  outputBytes: number(100, MAX_IMAGE_BYTES), faceModel: constant('ultraface-rfb-320'),
  modelSha256: constant(MODEL_SHA256), imageSha256: digest,
  input: shape({ width: number(1, 100_000), height: number(1, 100_000) }),
  backend: oneOf('wasm'), workerJsHeapBytes: nullable(number(0, 10_000_000_000))
}, ['schema','sanitized','rawScreenshotTransmitted','redactionApplied','domBoxes','faces','inferenceMs','totalMs','outputBytes','faceModel','modelSha256','imageSha256']);

export function migrateVisualPrivacyProof(value) {
  if (!value || typeof value !== 'object') reject('context.visualPrivacy', 'missing proof');
  if (value.schema === VISUAL_PRIVACY_SCHEMA) return visualProof(value, 'context.visualPrivacy');
  if (value.schema !== LEGACY_VISUAL_SCHEMA) reject('context.visualPrivacy', 'unknown proof schema');
  const old = oldProof(value, 'context.visualPrivacy');
  return visualProof({
    schema: VISUAL_PRIVACY_SCHEMA, sanitized: true, rawScreenshotTransmitted: false,
    redactionApplied: true, domBoxes: old.domBoxes, faces: old.faces,
    inferenceMs: old.inferenceMs, totalMs: old.totalMs, outputBytes: old.outputBytes,
    faceModel: old.faceModel, modelSha256: old.modelSha256, imageSha256: old.imageSha256,
    migratedFrom: LEGACY_VISUAL_SCHEMA
  }, 'context.visualPrivacy');
}

function image(value, path) {
  if (typeof value !== 'string' || value.length > 3_333_400 ||
    !/^data:image\/jpeg;base64,(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) reject(path, 'invalid JPEG data URL');
  return value;
}
const screenshotMetadata = shape({
  sanitized: constant(true), format: constant('image/jpeg'), bytes: number(100, MAX_IMAGE_BYTES),
  sha256: digest, rawScreenshotTransmitted: constant(false)
}, ['sanitized','format','bytes','sha256','rawScreenshotTransmitted']);

const contextShape = shape({
  site: oneOf('','youtube'), searchQuery: text(512), url, title: text(512),
  viewport: shape({ width: number(1, 100_000), height: number(1, 100_000), devicePixelRatio: number(0.01, 100) }),
  pageText: text(9_000), elements: arr(safeElement, 400), amazonProducts: arr(product, 80),
  amazonProductDetail: nullable(productDetail), textRegions: arr(region, 120),
  visualRegions: arr(region, 100), interactiveRegions: arr(safeElement, 400),
  ocr: shape({ status: oneOf('ready','cached','unavailable','not-configured','error'), regions: arr(region, 120), cached: boolean, latencyMs: number(), cacheKey: text(100), note: text(180) }),
  sensitiveRegions: arr(sensitiveRegion, 300),
  confidence: shape({ dom: number(0, 1), geometry: number(0, 1), ocr: number(0, 1), vision: number(0, 1), fused: number(0, 1) }),
  localTiming: shape({ readinessMs: number(), privacyRegionMs: number(), domExtractionMs: number(), accessibilityExtractionMs: number(), amazonExtractionMs: number(), textAndMetadataMs: number(), totalDomObservationMs: number(), ocrMs: number(), extensionDomRoundTripMs: number(), captureMs: number(), localVisionAndRedactionMs: number() }),
  pageMetadata: shape({ domFingerprint: shortHash, visibleTextHash: shortHash, elementCount: number(0, 100_000), meaningfulContent: boolean, capturedAt: number(0, 10_000_000_000_000), sanitizedScreenshotFingerprint: digest }),
  challenge: shape({ detected: boolean, kind: oneOf('','captcha','bot_challenge'), confidence: number(0, 1), indicators: arr(oneOf('challenge-control','verification-text'), 4) }),
  searchResults: arr(searchResult, 12), piiCounts: counts, media: arr(media, 4),
  vision: shape({
    interactiveRegions: number(0, 100_000), imageCount: number(0, 100_000), mediaCount: number(0, 100_000),
    mode: text(100), status: oneOf('sanitized','dom-sanitized-fast-path','visual-disabled','unavailable','error','unknown'), faces: number(0, 100_000), redactionBoxes: number(0, 100_000),
    inferenceMs: number(), totalMs: number(), rawScreenshotTransmitted: constant(false),
    screenshot: constant('disabled-until-complete-visual-redaction')
  }),
  screenshot: image, visualPrivacy: migrateVisualPrivacyProof, screenshotMetadata
}, ['url','title','elements']);

const verification = shape({ type: oneOf('playback'), query: text(240) });
const action = shape({
  schema: constant(ACTION_SCHEMA),
  type: oneOf('click','hover','submit','type','select','press','scroll','navigate','back','wait','request_local_input','finish','media'),
  target: shape({ ref }, ['ref']), value: text(500), key: text(40), direction: oneOf('up','down'),
  amount: number(0, 10_000), ms: number(0, 10_000), url, operation: oneOf('play','pause'),
  inputType: text(40), submit: boolean, message: text(500), completionStatus: oneOf('COMPLETED','PARTIAL','FAILED'),
  clarification: text(300), followUpPrefix: text(120), verification,
  expectedAsin: asin, expectedTitle: text(240), expectedPrice: number(0, 100_000_000),
  expectedUrl: url, expectedHost: text(250), compared: number(0, 100),
  reason: text(300)
}, ['type']);
export function validateActionV2(value) {
  const validated = action(value, 'action');
  if (validated.schema !== ACTION_SCHEMA) reject('action.schema', 'missing action schema');
  return validated;
}
const resultShape = shape({
  ok: boolean, navigated: boolean, done: boolean, pending: text(180),
  retryable: boolean, needsResume: boolean, navigationMs: number(), requiresSignIn: boolean,
  canonicalized: boolean, verified: boolean, message: text(300),
  error: oneOf('','Target not found'), navigateUrl: url, expectedSearchValue: text(500)
});
function result(value, path) {
  const { error, ...projected } = resultShape(value, path);
  // Known execution failures affect the next planner step through ok/retryable.
  // Their human-readable error text has no reason to enter a model request.
  return projected;
}
const amazonDiagnostic = shape({
  pageLoaded: boolean, candidatesFound: number(), candidatesWithAsin: number(), candidatesWithPrice: number(),
  organicCandidates: number(), qualifyingCandidates: number(), selectedAsin: asin,
  selectedPrice: nullable(number(0, 100_000_000)), verificationPassed: boolean,
  rejected: shape({ sponsored: number(), identity: number(), price: number(), productType: number() })
});
const historyEntry = shape({
  // `local-command` records a device-authorized direct text navigation that
  // occurred before the first protected-page observation. It is not a model
  // provider and must survive the strict history projection so the planner can
  // complete the already-verified navigation after consent.
  action, intent: text(100), reason: text(500), planner: oneOf('fast-command','ollama','remote-vlm','local-fallback','local-command'),
  result, pageChange: oneOf('INITIAL','BLOCKED','NAVIGATION','NO_CHANGE','LOADING','EXPECTED_CHANGE'),
  amazonDiagnostic, verification: shape({ ok: boolean, verified: boolean, retryable: boolean, message: text(300) }),
  model: text(100)
}, ['action']);
const observation = shape({
  schema: constant(OBSERVATION_SCHEMA), task: text(1_024), context: contextShape,
  history: arr(historyEntry, MAX_HISTORY)
}, ['task','context']);
const audit = shape({
  schema: constant(AUDIT_SCHEMA), sourceSchema: oneOf(OBSERVATION_SCHEMA,'captain.observation.legacy'),
  projectionSchema: constant(SANITIZED_SCHEMA), visualProof: oneOf('none','v2','migrated-v1'),
  privacyStatus: oneOf('safe','requires_review','blocked'),
  sourceClass: oneOf('dom','dom+visual'),
  detectorProofVersion: oneOf('none',VISUAL_PRIVACY_SCHEMA),
  reasonCodes: arr(oneOf('TEXT_ALLOWLIST_VALIDATED','VISUAL_PROOF_VALIDATED','OCR_ERROR','VISION_ERROR','HUMAN_CHALLENGE','UNRECOGNIZED_PRIVACY_REGION'), 6)
}, ['schema','sourceSchema','projectionSchema','visualProof','privacyStatus','sourceClass','detectorProofVersion','reasonCodes']);
const sanitized = shape({
  schema: constant(SANITIZED_SCHEMA), task: text(1_024), context: contextShape,
  history: arr(historyEntry, MAX_HISTORY), audit
}, ['schema','task','context','history','audit']);

function verifyImage(context) {
  const hasImage = HAS_OWN(context, 'screenshot');
  if (!hasImage) {
    if (HAS_OWN(context, 'visualPrivacy') || HAS_OWN(context, 'screenshotMetadata')) reject('context', 'orphan visual proof');
    return;
  }
  if (!context.visualPrivacy) reject('context', 'missing visual proof');
  const encoded = image(context.screenshot, 'context.screenshot').slice('data:image/jpeg;base64,'.length);
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length < 100 || bytes.length > MAX_IMAGE_BYTES || bytes.toString('base64') !== encoded ||
    bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff ||
    bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) reject('context.screenshot', 'invalid JPEG bitstream');
  const hash = createHash('sha256').update(bytes).digest('hex');
  const proof = visualProof(context.visualPrivacy, 'context.visualPrivacy');
  // A hash binds bytes to metadata, not to redaction. Only a native Phase-04
  // worker result with explicit opaque-mask coverage can be considered for
  // release. A migrated v1 proof is retained for schema compatibility only.
  if (proof.migratedFrom || proof.maskPolicy !== 'opaque-raster-v1' ||
    proof.coverageVerified !== true || !Number.isInteger(proof.pixelMaskCount) ||
    !proof.input || !Number.isInteger(proof.input.width) || !Number.isInteger(proof.input.height) ||
    proof.input.width * proof.input.height > 12_000_000) reject('context.visualPrivacy', 'unverified pixel mask coverage');
  if (proof.outputBytes !== bytes.length || proof.imageSha256 !== hash ||
    (context.screenshotMetadata && (context.screenshotMetadata.bytes !== bytes.length || context.screenshotMetadata.sha256 !== hash)) ||
    (context.pageMetadata?.sanitizedScreenshotFingerprint && context.pageMetadata.sanitizedScreenshotFingerprint !== hash)) reject('context.screenshot', 'proof integrity mismatch');
}

function removeOnlyValidatedTelemetry(context) {
  const { localTiming, piiCounts, ...safe } = context;
  return safe;
}

const KNOWN_PRIVACY_REGIONS = new Set([
  'EMAIL','PHONE','CARD','AADHAAR','PAN','PII','SECRET','RASTER_CONTENT','BACKGROUND_IMAGE',
  'NAME','FULL_NAME','ADDRESS','DATE_OF_BIRTH','DOB','PASSPORT','PASSPORT_NUMBER',
  'ACCOUNT','ACCOUNT_NUMBER','IFSC',
  'API_KEY','TOKEN','PASSWORD','OTP','PIN','CREDENTIAL','PERSON'
]);
function privacyAssessment(context) {
  const reasonCodes = ['TEXT_ALLOWLIST_VALIDATED'];
  let privacyStatus = 'safe';
  if (context.screenshot) reasonCodes.push('VISUAL_PROOF_VALIDATED');
  if (context.ocr?.status === 'error') {
    privacyStatus = 'requires_review';
    reasonCodes.push('OCR_ERROR');
  }
  if (context.vision?.status === 'error' || context.vision?.status === 'unknown' ||
    (context.screenshot && context.vision?.status && context.vision.status !== 'sanitized')) {
    privacyStatus = 'requires_review';
    reasonCodes.push('VISION_ERROR');
  }
  if (context.sensitiveRegions?.some(region => !KNOWN_PRIVACY_REGIONS.has(region.type))) {
    privacyStatus = 'blocked';
    reasonCodes.push('UNRECOGNIZED_PRIVACY_REGION');
  }
  if (context.challenge?.detected === true) {
    privacyStatus = 'blocked';
    reasonCodes.push('HUMAN_CHALLENGE');
  }
  return {
    privacyStatus,
    sourceClass: context.screenshot ? 'dom+visual' : 'dom',
    detectorProofVersion: context.screenshot ? VISUAL_PRIVACY_SCHEMA : 'none',
    reasonCodes
  };
}

export function sanitizeObservation(raw) {
  const sourceSchema = raw?.schema === OBSERVATION_SCHEMA ? OBSERVATION_SCHEMA : 'captain.observation.legacy';
  const projected = observation(raw, 'observation');
  const context = removeOnlyValidatedTelemetry(projected.context);
  verifyImage(context);
  const safe = {
    schema: SANITIZED_SCHEMA,
    task: projected.task,
    context,
    history: projected.history ?? [],
    audit: {
      schema: AUDIT_SCHEMA, sourceSchema, projectionSchema: SANITIZED_SCHEMA,
      visualProof: !context.screenshot ? 'none' : context.visualPrivacy.migratedFrom ? 'migrated-v1' : 'v2',
      ...privacyAssessment(context)
    }
  };
  return assertSafeToTransmit(safe);
}

export function assertSafeToTransmit(safePayload) {
  if (safePayload?.context?.visualPrivacy?.schema === LEGACY_VISUAL_SCHEMA) reject('payload.context.visualPrivacy', 'legacy proof requires migration');
  const safe = sanitized(safePayload, 'payload');
  verifyImage(safe.context);
  if (safe.context.visualPrivacy && safe.audit.visualProof !==
    (safe.context.visualPrivacy.migratedFrom ? 'migrated-v1' : 'v2')) reject('payload.audit', 'proof provenance mismatch');
  if (!safe.context.visualPrivacy && safe.audit.visualProof !== 'none') reject('payload.audit', 'proof provenance mismatch');
  const expectedAssessment = privacyAssessment(safe.context);
  if (safe.audit.privacyStatus !== expectedAssessment.privacyStatus ||
    safe.audit.sourceClass !== expectedAssessment.sourceClass ||
    safe.audit.detectorProofVersion !== expectedAssessment.detectorProofVersion ||
    JSON.stringify(safe.audit.reasonCodes) !== JSON.stringify(expectedAssessment.reasonCodes)) reject('payload.audit', 'privacy status mismatch');
  if (safe.audit.privacyStatus !== 'safe') reject('payload.audit', 'privacy review or blocked');
  const bytes = Buffer.byteLength(JSON.stringify(safe), 'utf8');
  if (bytes > MAX_JSON_BYTES) reject('payload', 'payload too large');
  return safe;
}
