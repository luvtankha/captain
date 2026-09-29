import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  OBSERVATION_SCHEMA, SANITIZED_SCHEMA, VISUAL_PRIVACY_SCHEMA, AUDIT_SCHEMA, ACTION_SCHEMA,
  sanitizeObservation, assertSafeToTransmit, migrateVisualPrivacyProof, validateActionV2
} from '../server/outbound-contract.mjs';

const MODEL_SHA256 = 'd7c687949526065ab6a192fdf993360045ce27b0fabf7c9fca5c2437b786b495';
const clone = value => structuredClone(value);
const element = () => ({
  ref: 'c1', tag: 'input', role: 'searchbox', type: 'search', name: 'Search',
  value: '', placeholder: 'Search', groupText: '', href: '', disabled: false,
  sensitive: false, sensitiveType: '', bbox: { x: 5, y: 7, width: 120, height: 24 },
  state: { checked: false, selected: null, expanded: null, readonly: false }, confidence: 1, source: 'dom'
});
const observation = () => ({
  task: 'Find a laptop', context: {
    site: '', searchQuery: 'laptop', url: 'https://example.test/shop', title: 'Catalog',
    viewport: { width: 1280, height: 720, devicePixelRatio: 1 },
    pageText: 'Laptop listing', elements: [element()], interactiveRegions: [element()],
    amazonProducts: [], amazonProductDetail: null, textRegions: [], visualRegions: [],
    ocr: { status: 'not-configured', regions: [], cached: false, note: 'No local OCR model installed.' },
    sensitiveRegions: [], confidence: { dom: 1, geometry: 0.8, ocr: 0 },
    localTiming: { domExtractionMs: 3, totalDomObservationMs: 4 }, piiCounts: {},
    pageMetadata: { domFingerprint: '1234abcd', visibleTextHash: '5678abcd', elementCount: 1, meaningfulContent: true, capturedAt: 1_000 },
    challenge: { detected: false, kind: '', confidence: 1, indicators: [] },
    searchResults: [], media: [], vision: { interactiveRegions: 1, imageCount: 0, mediaCount: 0, mode: 'DOM+local-visual-geometry' }
  },
  history: [{ action: { type: 'navigate', url: 'https://example.test/shop' }, result: { ok: true, navigated: true }, intent: 'open-shop', pageChange: 'NAVIGATION' }]
});

function withLegacyProof(raw = observation()) {
  const bytes = Buffer.alloc(120, 7);
  bytes[0] = 0xff; bytes[1] = 0xd8; bytes[2] = 0xff; bytes[118] = 0xff; bytes[119] = 0xd9;
  const hash = createHash('sha256').update(bytes).digest('hex');
  raw.context.screenshot = `data:image/jpeg;base64,${bytes.toString('base64')}`;
  raw.context.visualPrivacy = {
    schema: 'captain.visual-privacy.v1', sanitized: true, rawScreenshotTransmitted: false,
    redactionApplied: true, domBoxes: 1, faces: 1, faceMaxConfidence: 0.91,
    faceModel: 'ultraface-rfb-320', modelSha256: MODEL_SHA256,
    imageSha256: hash, input: { width: 1280, height: 720 }, outputBytes: bytes.length,
    inferenceMs: 11, totalMs: 17, backend: 'wasm', workerJsHeapBytes: null
  };
  raw.context.screenshotMetadata = {
    sanitized: true, format: 'image/jpeg', bytes: bytes.length, sha256: hash, rawScreenshotTransmitted: false
  };
  raw.context.pageMetadata.sanitizedScreenshotFingerprint = hash;
  return raw;
}

function withNativeProof(raw = observation()) {
  withLegacyProof(raw);
  raw.context.visualPrivacy = {
    ...migrateVisualPrivacyProof(raw.context.visualPrivacy),
    maskPolicy: 'opaque-raster-v1', coverageVerified: true, pixelMaskCount: 2,
    input: { width: 1280, height: 720 },
  };
  delete raw.context.visualPrivacy.migratedFrom;
  return raw;
}

function rejects(mutator, base = observation()) {
  const sample = clone(base);
  mutator(sample);
  assert.throws(() => sanitizeObservation(sample), error => {
    assert.equal(error.code, 'CAPTAIN_OUTBOUND_CONTRACT');
    assert.equal(error.status, 422);
    assert.doesNotMatch(error.message, /canary-payload|person@example\.com|private-token/i);
    return true;
  });
}

test('v2 projection retains planner fields, drops validated telemetry, and records audit schema', () => {
  const raw = observation(); raw.schema = OBSERVATION_SCHEMA;
  const safe = sanitizeObservation(raw);
  assert.equal(safe.schema, SANITIZED_SCHEMA);
  assert.equal(safe.audit.schema, AUDIT_SCHEMA);
  assert.equal(safe.audit.sourceSchema, OBSERVATION_SCHEMA);
  assert.equal(safe.audit.visualProof, 'none');
  assert.equal(safe.audit.privacyStatus, 'safe');
  assert.equal(safe.audit.sourceClass, 'dom');
  assert.equal(safe.audit.detectorProofVersion, 'none');
  assert.deepEqual(safe.audit.reasonCodes, ['TEXT_ALLOWLIST_VALIDATED']);
  assert.deepEqual(safe.history[0].action, raw.history[0].action);
  assert.deepEqual(safe.context.elements, raw.context.elements);
  assert.equal(safe.context.localTiming, undefined);
  assert.equal(safe.context.piiCounts, undefined);
  assert.deepEqual(assertSafeToTransmit(safe), safe);
  assert.equal(raw.context.localTiming.domExtractionMs, 3);
});

test('legacy unversioned 0.5 observation projects without mutating source', () => {
  const raw = observation();
  const before = clone(raw);
  const safe = sanitizeObservation(raw);
  assert.equal(safe.audit.sourceSchema, 'captain.observation.legacy');
  assert.deepEqual(raw, before);
});

test('legacy v1 visual proof can be inspected but cannot authorize screenshot egress', () => {
  const raw = withLegacyProof();
  const migrated = migrateVisualPrivacyProof(raw.context.visualPrivacy);
  assert.equal(migrated.schema, VISUAL_PRIVACY_SCHEMA);
  assert.equal(migrated.migratedFrom, 'captain.visual-privacy.v1');
  assert.equal(migrated.coverageVerified, undefined);
  assert.equal(migrated.workerJsHeapBytes, undefined);
  rejects(() => {}, raw);
});

test('native v2 opaque-coverage proof round trips without a fabricated migration marker', () => {
  const raw = withNativeProof();
  const safe = sanitizeObservation(raw);
  assert.equal(safe.audit.visualProof, 'v2');
  assert.equal(safe.context.visualPrivacy.migratedFrom, undefined);
  assert.equal(safe.context.visualPrivacy.coverageVerified, true);
  assert.equal(safe.context.visualPrivacy.maskPolicy, 'opaque-raster-v1');
  assert.equal(safe.audit.privacyStatus, 'safe');
  assert.deepEqual(safe.audit.reasonCodes, ['TEXT_ALLOWLIST_VALIDATED', 'VISUAL_PROOF_VALIDATED']);
  assert.deepEqual(assertSafeToTransmit(safe), safe);
});

test('canary, personal identifiers and private key material are blocked in text', () => {
  rejects(raw => { raw.context.pageText = 'canary-payload'; });
  rejects(raw => { raw.context.elements[0].name = 'person@example.com'; });
  rejects(raw => { raw.task = 'sk-abcdefghijklmnopqrstuvwxyz123456'; });
  rejects(raw => { raw.context.pageText = '-----BEGIN PRIVATE KEY-----'; });
});

test('URL query, fragment, embedded credentials and encoded PII are denied', () => {
  rejects(raw => { raw.context.url = 'https://example.test/shop?q=private-token'; });
  rejects(raw => { raw.context.url = 'https://example.test/shop#private-token'; });
  rejects(raw => { raw.context.elements[0].href = 'https://name:private-token@example.test/'; });
  rejects(raw => { raw.context.elements[0].href = 'https://example.test/person%40example.com'; });
});

test('history URL, history message, raw errors and unrecognized result keys are blocked', () => {
  rejects(raw => { raw.history[0].action.url = 'https://example.test/path?secret=1'; });
  rejects(raw => { raw.history[0].result.message = 'canary-payload'; });
  rejects(raw => { raw.history[0].result.error = 'private-token'; });
  rejects(raw => { raw.history[0].result.debug = { token: 'private-token' }; });
});

test('known local target-not-found recovery retains state without transmitting error text', () => {
  const raw = observation();
  raw.history[0].result = { ok: false, retryable: true, error: 'Target not found' };
  const safe = sanitizeObservation(raw);
  assert.deepEqual(safe.history[0].result, { ok: false, retryable: true });
  assert.deepEqual(assertSafeToTransmit(safe), safe);
});

test('unexpected root, context and deep element fields fail closed', () => {
  rejects(raw => { raw.debug = 'private-token'; });
  rejects(raw => { raw.context.storage = { tokens: ['private-token'] }; });
  rejects(raw => { raw.context.elements[0].state.secret = 'private-token'; });
  rejects(raw => { raw.context.searchResults = [{ ref: 'c1', title: 'Product', href: 'https://example.test/product', metadata: { token: 'private-token' } }]; });
});

test('unrecognized observation, sanitized and visual schemas fail closed', () => {
  rejects(raw => { raw.schema = 'captain.observation.v99'; });
  rejects(raw => { raw.context.visualPrivacy = { schema: 'captain.visual-privacy.v99' }; });
  const safe = sanitizeObservation(observation());
  assert.throws(() => assertSafeToTransmit({ ...safe, schema: 'captain.sanitized.v99' }), /contract rejected/);
  assert.throws(() => assertSafeToTransmit({ ...safe, audit: { ...safe.audit, schema: 'captain.audit.v2' } }), /contract rejected/);
});

test('hard text, array and history limits reject excess rather than truncate', () => {
  rejects(raw => { raw.task = 'x'.repeat(1_025); });
  rejects(raw => { raw.context.pageText = 'x'.repeat(9_001); });
  rejects(raw => { raw.context.elements = Array.from({ length: 401 }, element); });
  rejects(raw => { raw.history = Array.from({ length: 21 }, () => ({ action: { type: 'wait' } })); });
});

test('invalid numbers, prototypes, sparse arrays, accessors and hidden fields fail closed', () => {
  rejects(raw => { raw.context.elements[0].confidence = Infinity; });
  rejects(raw => { raw.context.elements[0].bbox.width = -1; });
  rejects(raw => { raw.context.elements = new Array(2); });
  rejects(raw => { raw.context.elements[0] = new Date(); });
  rejects(raw => { Object.defineProperty(raw.context.elements[0], 'secret', { value: 'private-token', enumerable: false }); });
});

test('screenshots require visual proof, JPEG framing and matching digest', () => {
  rejects(raw => { raw.context.screenshot = 'data:image/jpeg;base64,AAAA'; });
  rejects(raw => { raw.context.visualPrivacy = withLegacyProof().context.visualPrivacy; });
  rejects(raw => { const image = withNativeProof(); raw.context = image.context; raw.context.visualPrivacy.imageSha256 = '0'.repeat(64); });
  rejects(raw => { const image = withNativeProof(); raw.context = image.context; raw.context.visualPrivacy.redactionApplied = false; });
  rejects(raw => { const image = withNativeProof(); raw.context = image.context; raw.context.screenshotMetadata.sha256 = '0'.repeat(64); });
  rejects(raw => { const image = withNativeProof(); raw.context = image.context; raw.context.screenshot = raw.context.screenshot.slice(0, -4) + 'AAAA'; });
});

test('oversized JPEG image refuses egress before binary proof checking', () => {
  const raw = withNativeProof();
  const bytes = Buffer.alloc(2_500_001, 7);
  raw.context.screenshot = `data:image/jpeg;base64,${bytes.toString('base64')}`;
  assert.throws(() => sanitizeObservation(raw), /contract rejected/);
});

test('assertion does not accept legacy proof or forged sanitized payload fields', () => {
  const raw = withNativeProof();
  const safe = sanitizeObservation(raw);
  const legacy = clone(safe); legacy.context.visualPrivacy = withLegacyProof().context.visualPrivacy;
  assert.throws(() => assertSafeToTransmit(legacy), /legacy proof requires migration/);
  assert.throws(() => assertSafeToTransmit({ ...safe, requestHeaders: { authorization: 'private-token' } }), /unexpected field/);
  assert.throws(() => assertSafeToTransmit({ ...safe, audit: { ...safe.audit, visualProof: 'migrated-v1' } }), /proof provenance mismatch/);
  const bad = clone(safe); bad.context.elements[0].value = 'canary-payload';
  assert.throws(() => assertSafeToTransmit(bad), /contract rejected/);
});

test('v2 screenshot egress refuses unverified, absent, or malformed opaque mask coverage', () => {
  rejects(raw => { raw.context = withNativeProof().context; delete raw.context.visualPrivacy.coverageVerified; });
  rejects(raw => { raw.context = withNativeProof().context; raw.context.visualPrivacy.coverageVerified = false; });
  rejects(raw => { raw.context = withNativeProof().context; raw.context.visualPrivacy.maskPolicy = 'pixelated'; });
  rejects(raw => { raw.context = withNativeProof().context; raw.context.visualPrivacy.pixelMaskCount = 0; });
  rejects(raw => { raw.context = withNativeProof().context; raw.context.visualPrivacy.pixelMaskCount = 0.5; });
  rejects(raw => { raw.context = withNativeProof().context; raw.context.visualPrivacy.input.width = Infinity; });
  rejects(raw => { raw.context = withNativeProof().context; raw.context.visualPrivacy.input.height = 0; });
  rejects(raw => { raw.context = withNativeProof().context; raw.context.visualPrivacy.migratedFrom = 'captain.visual-privacy.v1'; });
});

test('known media error code remains bounded while arbitrary error metadata is rejected', () => {
  const raw = observation();
  raw.context.media = [{ paused: true, ended: false, readyState: 0, networkState: 3,
    currentTime: 0, visible: true, pageVisible: true, error: { code: 2, message: 'The player could not download its media.' }, primary: true }];
  assert.deepEqual(sanitizeObservation(raw).context.media, raw.context.media);
  rejects(sample => { sample.context.media = [{ ...raw.context.media[0], error: { code: 2, message: 'canary-payload' } }]; });
});

test('representative Amazon and search observation preserves grounded selectors and only known privacy counters', () => {
  const raw = observation();
  raw.context.site = 'youtube';
  raw.context.elements[0].state.options = [{ text: 'Laptop', value: 'laptop', selected: true }];
  raw.context.elements[0].source = 'AMAZON_SEMANTIC_DOM';
  raw.context.elements[0].sensitive = true;
  raw.context.elements[0].name = '[REDACTED_SECRET]';
  raw.context.elements[0].value = '[REDACTED_SECRET]';
  raw.context.elements[0].state.options = [];
  raw.context.amazonProducts = [{
    asin: 'B0ABCDEFGH', title: 'Laptop 16GB SSD', price: 42_000, currency: 'INR',
    rating: 4.5, ratingCount: 1_200, url: 'https://www.amazon.in/dp/B0ABCDEFGH',
    availability: 'In stock', sponsored: false, position: 1, confidence: 1,
    ref: 'c1', bbox: { x: 5, y: 7, width: 120, height: 24 }
  }];
  raw.context.amazonProductDetail = {
    asin: 'B0ABCDEFGH', title: 'Laptop 16GB SSD', price: 42_000,
    currency: 'INR', url: 'https://www.amazon.in/dp/B0ABCDEFGH'
  };
  raw.context.searchResults = [{ ref: 'c1', title: 'Catalog', href: 'https://example.test/catalog', source: 'displayed-origin' }];
  raw.context.piiCounts = { PII: 1, RASTER_CONTENT: 2, BACKGROUND_IMAGE: 1, FULL_NAME: 1 };
  raw.history.push({ action: { type: 'click', target: { ref: 'c1' }, expectedAsin: 'B0ABCDEFGH' },
    intent: 'shopping-amazon-product', result: { ok: true, navigated: true },
    amazonDiagnostic: { pageLoaded: true, candidatesFound: 1, candidatesWithAsin: 1, candidatesWithPrice: 1,
      organicCandidates: 1, qualifyingCandidates: 1, selectedAsin: 'B0ABCDEFGH',
      selectedPrice: 42_000, verificationPassed: true } });
  const safe = sanitizeObservation(raw);
  assert.deepEqual(safe.context.amazonProducts, raw.context.amazonProducts);
  assert.deepEqual(safe.context.amazonProductDetail, raw.context.amazonProductDetail);
  assert.deepEqual(safe.context.searchResults, raw.context.searchResults);
  assert.equal(safe.context.piiCounts, undefined);
  assert.equal(safe.history[1].action.expectedAsin, 'B0ABCDEFGH');
  assert.equal(safe.context.elements[0].value, '[REDACTED_SECRET]');
});

test('sensitive values, double-encoded URL path and image data hidden in text fail closed', () => {
  rejects(raw => { raw.context.elements[0].sensitive = true; raw.context.elements[0].value = 'private-token'; });
  rejects(raw => { raw.context.url = 'https://example.test/%253Fsecret%253Dprivate-token'; });
  rejects(raw => { raw.context.pageText = 'data:image/png;base64,private-token'; });
});

test('action-v2 validator requires exact version and rejects unexpected action data', () => {
  assert.deepEqual(validateActionV2({ schema: ACTION_SCHEMA, type: 'click', target: { ref: 'c1' } }),
    { schema: ACTION_SCHEMA, type: 'click', target: { ref: 'c1' } });
  assert.throws(() => validateActionV2({ type: 'click', target: { ref: 'c1' } }), /action schema/);
  assert.throws(() => validateActionV2({ schema: 'captain.action.v9', type: 'click' }), /contract rejected/);
  assert.throws(() => validateActionV2({ schema: ACTION_SCHEMA, type: 'click', debug: { password: 'synthetic' } }), /unexpected field/);
  assert.equal(sanitizeObservation({ ...observation(), history: [{ action: { type: 'wait' } }] }).history[0].action.schema, undefined,
    'legacy 0.5.0 history actions retain their original shape');
});

test('unknown privacy regions, OCR failures and human challenges fail closed', () => {
  rejects(raw => { raw.context.sensitiveRegions = [{ id: 's1', type: 'UNRECOGNIZED', bbox: { x: 1, y: 1, width: 4, height: 4 }, confidence: 1, source: 'DOM_PRIVACY' }]; });
  rejects(raw => { raw.context.ocr.status = 'error'; });
  rejects(raw => { raw.context.vision.status = 'unknown'; });
  rejects(raw => { raw.context.challenge = { detected: true, kind: 'captcha', confidence: 0.99, indicators: ['challenge-control'] }; });
  const safe = sanitizeObservation(observation());
  assert.throws(() => assertSafeToTransmit({ ...safe, audit: { ...safe.audit, privacyStatus: 'blocked' } }), /privacy status mismatch/);
  assert.throws(() => assertSafeToTransmit({ ...safe, audit: { ...safe.audit, reasonCodes: ['TEXT_ALLOWLIST_VALIDATED', 'VISION_ERROR'] } }), /privacy status mismatch/);
});
