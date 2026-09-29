// A single server-side telemetry projection. Never retain arbitrary client JSON.
// These counters are operational hints, not evidence of detector accuracy.
const MODES = new Set(['DOM+UltraFace+local-redaction', 'DOM+Amazon-semantic-fast-path']);
const STATUSES = new Set(['sanitized', 'dom-sanitized-fast-path', 'visual-disabled']);
const NUMERIC = ['latencyMs', 'piiDetected', 'steps'];
const VISION_NUMERIC = ['faces', 'redactionBoxes', 'inferenceMs', 'totalMs'];
const HEX = /^[a-f0-9]{64}$/i;

function count(value, max = 3_600_000) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > max) {
    throw new TypeError('Invalid telemetry metric');
  }
  return Math.round(value);
}

export function sanitizeMetricSample(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid telemetry payload');
  if (Object.keys(value).some(key => ![...NUMERIC, 'vision'].includes(key))) throw new TypeError('Unexpected telemetry field');
  const sample = {};
  for (const key of NUMERIC) if (Object.hasOwn(value, key)) sample[key] = count(value[key]);
  if (value.vision != null) {
    if (typeof value.vision !== 'object' || Array.isArray(value.vision)) throw new TypeError('Invalid vision telemetry');
    if (Object.keys(value.vision).some(key => !['mode', 'status', 'rawScreenshotTransmitted', ...VISION_NUMERIC].includes(key))) throw new TypeError('Unexpected vision telemetry field');
    const vision = {
      mode: MODES.has(value.vision.mode) ? value.vision.mode : 'unknown',
      status: STATUSES.has(value.vision.status) ? value.vision.status : 'unknown',
    };
    for (const key of VISION_NUMERIC) if (Object.hasOwn(value.vision, key)) vision[key] = count(value.vision[key]);
    if (value.vision.rawScreenshotTransmitted !== undefined) {
      if (value.vision.rawScreenshotTransmitted !== false) throw new TypeError('Unsafe visual telemetry flag');
      vision.rawScreenshotTransmitted = false;
    }
    sample.vision = vision;
  }
  return sample;
}

export function sanitizeVisualAudit(proof) {
  if (!proof || typeof proof !== 'object' || Array.isArray(proof)) throw new TypeError('Invalid visual audit');
  const audit = {
    receivedAt: new Date().toISOString(),
    schema: proof.schema === 'captain.visual-privacy.v2' ? proof.schema : 'unknown',
    screenshotField: 'sanitized-jpeg',
    rawScreenshotReceived: false,
  };
  if (proof.sanitized !== true || proof.rawScreenshotTransmitted !== false) throw new TypeError('Unverified visual audit');
  audit.sanitized = true;
  audit.rawScreenshotTransmitted = false;
  for (const key of ['domBoxes', 'faces', 'inferenceMs', 'totalMs', 'outputBytes']) {
    if (Object.hasOwn(proof, key)) audit[key] = count(proof[key], 3_000_000);
  }
  for (const key of ['imageSha256', 'modelSha256']) if (typeof proof[key] === 'string' && HEX.test(proof[key])) audit[key] = proof[key];
  if (proof.faceModel === 'ultraface-rfb-320') audit.faceModel = proof.faceModel;
  return audit;
}
