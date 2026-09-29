import { createHash } from 'node:crypto';
import '../extension/privacy/privacy-core.js';

const privacy = globalThis.CAPTAIN_PRIVACY;

const FACE_MODEL_SHA256 = 'd7c687949526065ab6a192fdf993360045ce27b0fabf7c9fca5c2437b786b495';

export function validateSanitizedScreenshot(context = {}) {
  if (!context.screenshot) return { ok: true, present: false };
  const proof = context.visualPrivacy;
  if (!proof || proof.schema !== 'captain.visual-privacy.v2' || proof.sanitized !== true || proof.rawScreenshotTransmitted !== false || proof.redactionApplied !== true || proof.migratedFrom || proof.maskPolicy !== 'opaque-raster-v1' || proof.coverageVerified !== true || !Number.isInteger(proof.pixelMaskCount) || proof.pixelMaskCount < 1 || !Number.isInteger(proof.input?.width) || !Number.isInteger(proof.input?.height) || proof.input.width < 1 || proof.input.height < 1 || proof.input.width * proof.input.height > 12_000_000) return { ok: false, error: 'missing local redaction proof' };
  if (proof.faceModel !== 'ultraface-rfb-320' || proof.modelSha256 !== FACE_MODEL_SHA256) return { ok: false, error: 'unexpected local face model' };
  if (![proof.domBoxes, proof.faces, proof.inferenceMs, proof.totalMs, proof.outputBytes].every(value => Number.isFinite(value) && value >= 0)) return { ok: false, error: 'invalid visual metrics' };
  const match = String(context.screenshot).match(/^data:image\/jpeg;base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match) return { ok: false, error: 'visual payload must be a JPEG data URL' };
  const bytes = Buffer.from(match[1], 'base64');
  if (bytes.length < 100 || bytes.length > 2_500_000 || bytes.length !== proof.outputBytes) return { ok: false, error: 'visual payload size mismatch' };
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) return { ok: false, error: 'visual payload is not a JPEG bitstream' };
  const hash = createHash('sha256').update(bytes).digest('hex');
  if (hash !== proof.imageSha256) return { ok: false, error: 'visual payload hash mismatch' };
  return { ok: true, present: true, bytes: bytes.length };
}

export function scanText(value = '') {
  return privacy.scanSpans(value).map(({ start, end, type }) => ({
    kind: type.toLowerCase(), index: start, length: end - start
  }));
}

export function redactText(value = '') {
  const source = String(value);
  let text = source;
  const counts = {};
  const spans = privacy.scanSpans(source);
  for (const { type } of spans) {
    const kind = type.toLowerCase();
    counts[kind] = (counts[kind] || 0) + 1;
  }
  for (let i = spans.length - 1; i >= 0; i--) {
    const { start, end, type } = spans[i];
    text = text.slice(0, start) + `[REDACTED_${type}]` + text.slice(end);
  }
  return { text, counts };
}

export function payloadLeaks(value) {
  const findings = [];
  // Scan decoded field values, not serialized JSON: an escaped newline before
  // @channel.example otherwise invents an email address "n@channel.example".
  function walk(node, path = 'root') {
    if (typeof node === 'string') findings.push(...scanText(node).map(item => ({ ...item, path })));
    // Numeric fields are measurements, counters and geometry in the protocol.
    // User-visible values are serialized as strings by the page observer.
    // Scanning floating-point coordinates creates random 13–19 digit matches.
    else if (node && typeof node === 'object') for (const [key, child] of Object.entries(node)) {
      findings.push(...scanText(key).map(item => ({ ...item, path })));
      if (path === 'root.context' && key === 'screenshot' && child) {
        if (!validateSanitizedScreenshot(node).ok) findings.push({ kind: 'unverified_screenshot', path: `${path}.${key}` });
      }
      else if (path === 'root.context.visualPrivacy' && ['imageSha256', 'modelSha256', 'schema', 'faceModel'].includes(key)) {
        // Integrity identifiers are validated structurally by
        // validateSanitizedScreenshot. Digit runs inside a SHA-256 digest are
        // not user card numbers and must not create random false positives.
      }
      else walk(child, `${path}.${key}`);
    }
  }
  walk(value);
  return findings;
}
