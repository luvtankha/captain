import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeMetricSample, sanitizeVisualAudit } from '../server/metrics.mjs';

test('metric sink retains only bounded numeric and enumerated synthetic fields', () => {
  assert.deepEqual(sanitizeMetricSample({
    latencyMs: 120, steps: 2, piiDetected: 1,
    vision: { mode: 'DOM+UltraFace+local-redaction', status: 'sanitized', faces: 0, redactionBoxes: 3, totalMs: 14 },
  }), {
    latencyMs: 120, steps: 2, piiDetected: 1,
    vision: { mode: 'DOM+UltraFace+local-redaction', status: 'sanitized', faces: 0, redactionBoxes: 3, totalMs: 14 },
  });
});

test('metric sink rejects unexpected raw values and malformed numerics', () => {
  for (const invalid of [
    { task: 'canary-private-data', latencyMs: 12 },
    { latencyMs: Infinity }, { latencyMs: -1 }, { latencyMs: '100' },
    { vision: { mode: 'custom-secret', pageText: 'canary-private-data' } },
    { vision: { rawScreenshotTransmitted: true } },
  ]) assert.throws(() => sanitizeMetricSample(invalid), /Invalid|Unexpected|Unsafe/);
});

test('visual audit projects integrity fields only, never arbitrary supplied notes', () => {
  const proof = { schema: 'captain.visual-privacy.v2', sanitized: true, rawScreenshotTransmitted: false,
    imageSha256: 'a'.repeat(64), modelSha256: 'b'.repeat(64), faceModel: 'ultraface-rfb-320',
    faces: 1, secret: 'canary-private-data' };
  const audit = sanitizeVisualAudit(proof);
  assert.equal(audit.imageSha256, proof.imageSha256);
  assert.equal(audit.faces, 1);
  assert.equal(audit.rawScreenshotReceived, false);
  assert.doesNotMatch(JSON.stringify(audit), /canary-private-data|secret/);
  assert.throws(() => sanitizeVisualAudit({ ...proof, sanitized: false }), /Unverified/);
});
