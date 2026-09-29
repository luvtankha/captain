// Five real extension-local privacy cycles. Outputs numerical evidence only;
// the raw screenshot never enters this Node process or the persisted report.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { summarize } from './phase-08-score.mjs';

const samples = [];
for (let run = 1; run <= 5; run++) {
  const child = spawnSync(process.execPath,
    [new URL('audit-visual-privacy.mjs', import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:\/)/, ''), '--privacy-only'],
    { cwd: new URL('../', import.meta.url), encoding: 'utf8', timeout: 120000, maxBuffer: 4_000_000 });
  assert.equal(child.status, 0, 'A full strict screenshot audit did not pass.');
  const result = JSON.parse(await readFile(new URL('../runtime/visual-privacy-audit.json', import.meta.url), 'utf8'));
  assert.equal(result.passed, true);
  assert.equal(result.mode, 'privacy-pixel-metrics-only');
  assert.equal(result.assertions.sanitizedPayloadAccepted, true);
  assert.equal(result.assertions.tamperedPayloadRejected, true);
  assert.equal(result.assertions.rawScreenshotSentToServer, false);
  const redaction = result.evaluation.redaction;
  const actualPixels = result.evaluation.actualJpegCoverage;
  const publicPixels = result.evaluation.publicPixelPreservation;
  assert.equal(publicPixels?.method, 'private-worker-labelled-public-JPEG-comparison');
  assert.ok(publicPixels.labelledRegions > 0 && publicPixels.sampledPixels > 0);
  assert.equal(actualPixels?.method, 'decoded-outgoing-JPEG-labelled-interior');
  assert.equal(actualPixels.allLabelledInteriorsOpaque, true);
  assert.equal(actualPixels.expectedRegions, 7);
  assert.ok(actualPixels.regions.every(region => region.total > 0 &&
    region.masked === region.total && region.maskedPercent === 100));
  assert.equal(actualPixels.fixtureLabelledPixelConfusion?.privateUnmasked,0,
    'Private labelled interior pixels were not opaque.');
  const required = ['EMAIL','PHONE','PAN','ADDRESS','PASSWORD','CREDENTIAL','RASTER_CONTENT'];
  assert.ok(required.every(kind => redaction.perRegion.some(item => item.kind === kind && item.maskedPercent === 100)));
  const timings = result.evaluation.latency;
  samples.push({ run, success:true, actualJpegLabelledInteriorsOpaque:true,
    actualJpegLabelledRegions:actualPixels.expectedRegions,
    publicPixelChangedPercent:publicPixels.changedPercent,
    selectivePreservationAccepted:publicPixels.selectivePreservationAccepted,
    maskRecallPercent:redaction.recallPercent,
    maskPrecisionPercent:redaction.precisionPercent,
    observedOpaquePixelPrecisionPercent:actualPixels.fixtureLabelledPixelConfusion.observedOpaquePrecisionPercent,
    outsideLabelOpaquePercent:actualPixels.fixtureLabelledPixelConfusion.observedOutsideOpaquePercent,
    localStageTimings:result.evaluation.localStageTimings,
    inferenceMs:timings.localInferenceMs,
    localRedactionTotalMs:timings.localSanitizationTotalMs,
    sanitizedServerRoundTripMs:timings.sanitizedServerRoundTripMs,
    aggregateDedicatedBrowserWorkingSetMiBUpperBound:
      result.evaluation.clientResources.aggregateChromeWorkingSetMiBUpperBound,
    activeAggregateCpuPercentOfOneCore:
      result.evaluation.clientResources.activeAggregateCpu.aggregatePercentOfOneCore });
  console.log(JSON.stringify(samples.at(-1)));
}
const timings = Object.fromEntries([
  'inferenceMs','localRedactionTotalMs','sanitizedServerRoundTripMs',
  'aggregateDedicatedBrowserWorkingSetMiBUpperBound','activeAggregateCpuPercentOfOneCore'
].map(field=>[field,summarize(samples.map(item=>item[field]))]));
const stageTimings=Object.fromEntries([
  'faceModelLoadMs','faceInferenceMs','ocrAndReviewMs',
  'uiFusionMs','pixelRedactionEncodeAndProofMs'
].map(field=>[field,summarize(samples.map(item=>item.localStageTimings[field]))]));
const report={schema:'captain.original-phase-08.privacy-five-run.v1',
  scope:'Five strict synthetic private-browser capture/redaction and authenticated server rounds; no production planner/action loop in these samples.',
  passed:true,samples,timings,stageTimings,
  selectivePreservation:{passed:samples.filter(x=>x.selectivePreservationAccepted).length,
    failed:samples.filter(x=>!x.selectivePreservationAccepted).length,
    meaning:'Utility result for independently labelled public JPEG regions; false does not mean a privacy leak.'},
  limits:'CPU and RAM figures are aggregate dedicated-browser upper bounds, not extension-only. Zero uncovered labelled fixture pixels does not prove general PII or photo-face recall.'};
await writeFile(new URL('../runtime/phase-08-privacy-five-run.json', import.meta.url), JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({count:5,passed:5,timings}));
