// Original Phase 8: distinct controlled variants of one synthetic pixel fixture.
// This is NOT an untouched held-out set or independent learned-model accuracy.
// Child transcripts and screenshot bytes never enter the persisted report.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const variants = Object.freeze([
  { name: 'base', flag: null },
  { name: 'dark', flag: '--dark' },
  { name: 'zoom125', flag: '--zoom125' },
  { name: 'zoom75', flag: '--zoom75' }
]);
const report = {
  schema: 'captain.original-phase-08.synthetic-variant-pixels.v1',
  scope: 'Actual private extension outgoing JPEG, same pre-inspected labelled synthetic fixture under controlled theme/zoom mutations',
  limitation: 'No untouched held-out data, real-world face recall, model-only accuracy, or general-site privacy inference. Blackout is privacy-safe but fails selective visual utility.',
  planned: variants.length, completed: 0, privacyPassed: 0,
  selectivePreservationPassed: 0, results: []
};
try {
  for (const variant of variants) {
    const args = [new URL('audit-visual-privacy.mjs', import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:\/)/, ''), '--privacy-only'];
    if (variant.flag) args.push(variant.flag);
    const child = spawnSync(process.execPath, args, {
      cwd: new URL('../', import.meta.url), encoding: 'utf8', windowsHide: true,
      timeout: 120000, maxBuffer: 4_000_000
    });
    let source;
    if (child.status === 0 && !child.error) {
      try { source = JSON.parse(await readFile(new URL('../runtime/visual-privacy-audit.json', import.meta.url), 'utf8')); }
      catch { /* Bad or incomplete report is a failed run, not a success. */ }
    }
    const safe = source?.passed === true && source?.variant === variant.name &&
      source?.mode === 'privacy-pixel-metrics-only' &&
      source?.evaluation?.actualJpegCoverage?.expectedRegions === 7 &&
      source.evaluation.actualJpegCoverage.allLabelledInteriorsOpaque === true &&
      source.assertions?.sanitizedPayloadAccepted === true &&
      source.assertions?.tamperedPayloadRejected === true &&
      source.assertions?.rawScreenshotSentToServer === false &&
      source.evaluation.publicPixelPreservation?.sampledPixels > 0;
    const pixels = source?.evaluation?.publicPixelPreservation;
    const record = {
      variant: variant.name, privacyPassed: safe,
      labelledPrivateRegions: safe ? source.evaluation.actualJpegCoverage.expectedRegions : null,
      publicSamplePixels: safe ? pixels.sampledPixels : null,
      publicPixelsChangedPercent: safe ? pixels.changedPercent : null,
      selectivePreservationPassed: safe ? pixels.selectivePreservationAccepted === true : false,
      ocrRejectClass: safe ? source.evaluation.localOcrRejectClass : null,
      ocrRejectScope: safe ? source.evaluation.localOcrRejectScope : null,
      failureClass: safe ? null : child.error?.code === 'ETIMEDOUT' ? 'TIMEOUT' :
        child.status === 0 ? 'INVALID_REPORT' : 'FAILED_PRIVACY_AUDIT'
    };
    report.results.push(record); report.completed++;
    if (safe) report.privacyPassed++;
    if (record.selectivePreservationPassed) report.selectivePreservationPassed++;
    console.log(JSON.stringify(record));
    // Never race a failed extension/privacy operation with another browser job.
    if (!safe) break;
  }
} finally {
  report.privacyAccepted = report.completed === variants.length && report.privacyPassed === variants.length;
  report.selectivePreservationAccepted = report.privacyAccepted &&
    report.selectivePreservationPassed === variants.length;
  report.finishedAt = new Date().toISOString();
  await mkdir(new URL('../runtime/', import.meta.url), { recursive: true });
  await writeFile(new URL('../runtime/phase-08-variant-pixels.json', import.meta.url),
    JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ completed: report.completed, privacyPassed: report.privacyPassed,
    selectivePreservationPassed: report.selectivePreservationPassed,
    privacyAccepted: report.privacyAccepted,
    selectivePreservationAccepted: report.selectivePreservationAccepted }));
  assert.equal(report.privacyAccepted, true, 'The synthetic variant privacy gate did not pass.');
}
