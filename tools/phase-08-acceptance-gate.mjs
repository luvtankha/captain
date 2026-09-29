// ORIGINAL plan Phase 8 evidence gate: completion of *evaluation*, not a claim
// that the trained detector is accurate, selective visual redaction works, or
// the extension is ready for a public store. No fixtures or labels are edited.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
const read=async name=>JSON.parse(await readFile(new URL('../runtime/'+name,import.meta.url),'utf8'));
const dom=await read('phase-08-evaluation.json');
const ui=await read('phase-08-heldout-browser-ui.json');
const privacy=await read('phase-08-privacy-five-run.json');
const egress=await read('phase-08-scoped-egress.json');
const modes=Object.fromEntries(await Promise.all(['public','form','visual','public-dom'].map(async mode=>[
 mode,await read(`phase-08-real-${mode}-trials.json`)])));
const integer=n=>Number.isSafeInteger(n)&&n>=0;
const timing=n=>typeof n==='number'&&Number.isFinite(n)&&n>=0;

// Controlled source corpus is post-inspection/relabelled; this is not a
// trained-model accuracy score or an untouched held-out study.
assert.equal(dom.summary.total,40);assert.equal(dom.summary.passed,40);
assert.equal(dom.summary.failed,0);assert.equal(dom.summary.syntheticCanaryAbsent,true);
assert.ok(timing(dom.summary.observationRoundTrip.p95Ms));
assert.ok(timing(dom.summary.dom.p95Ms));

assert.equal(ui.summary.complete,true);
assert.equal(ui.attempted,13);
assert.equal(ui.checkpointSha256,'d29b6210d171e3dc5454e09847aaabce6a0255eaefa565b639e1301a9e933ef9');
assert.equal(ui.summary.tp+ui.summary.fn,43);
assert.ok(ui.cases.every(x=>x.ok===true&&x.modelVerified===true&&
 x.rawScreenshotReturnedToNode===false&&x.boxesReturnedToNode===false&&
 x.shapeBoxesReturnedToNode===false&&integer(x.tp)&&integer(x.fp)&&integer(x.fn)));
assert.ok(timing(ui.summary.timings.p95Ms));
assert.ok(ui.summary.researchOnlyCommunityONNX.notProduction===true);
assert.equal(ui.summary.researchOnlyCommunityONNX.redistributionProvenanceVerified,false);

assert.equal(privacy.passed,true);assert.equal(privacy.samples.length,5);
assert.ok(privacy.samples.every(x=>x.success&&x.actualJpegLabelledInteriorsOpaque&&
 x.actualJpegLabelledRegions===7&&x.maskRecallPercent===100));
assert.equal(privacy.selectivePreservation.passed+privacy.selectivePreservation.failed,5);
for(const key of ['localRedactionTotalMs','sanitizedServerRoundTripMs',
 'aggregateDedicatedBrowserWorkingSetMiBUpperBound','activeAggregateCpuPercentOfOneCore'])
 assert.ok(timing(privacy.timings[key]?.p95Ms),`Unmeasured resource/transport ${key}`);
for(const key of ['faceModelLoadMs','faceInferenceMs','ocrAndReviewMs','uiFusionMs',
 'pixelRedactionEncodeAndProofMs'])
 assert.ok(timing(privacy.stageTimings[key]?.p95Ms),`Unmeasured private ${key}`);

for(const name of ['public','form','visual']){
 const sample=modes[name];assert.equal(sample.accepted,true);
 assert.equal(sample.completedRuns,5);assert.equal(sample.passedRuns,5);
 assert.ok(sample.trials.every(x=>x.passed&&timing(x.durationMs)));
 assert.ok(timing(sample.wallClockMs.p50Ms)&&timing(sample.wallClockMs.p95Ms));
}
assert.equal(modes['public-dom'].accepted,true);
assert.equal(modes['public-dom'].passedRuns,5);
assert.ok(modes.public.stageSamples.SCREEN_CAPTURE.count>0);
assert.ok(modes.public.stageSamples.LOCAL_VISION_REDACTION.count>0);
assert.ok(modes.visual.stageSamples.PLANNER.count>0);

assert.equal(egress.passed,true);assert.equal(egress.syntheticTasksVerified,4);
assert.equal(egress.visualGroundingVerified,true);
assert.equal(egress.completePostBodiesChecked,true);
assert.equal(egress.syntheticCanaryClasses,7);
assert.ok(egress.plannerPosts>=8&&egress.metricsPosts>=4&&egress.genuineV2Proofs>=8);
assert.equal(egress.unexpectedPrivateWorkerPosts,0);
assert.equal(egress.rawFixtureCanaryObservedOutbound,false);
assert.equal(egress.noPersonalData,true);

const modelQualityAccepted=ui.summary.modelUtilityEstablished===true;
const selectiveUtilityAccepted=privacy.selectivePreservation.passed===5;
const report={schema:'captain.original-phase-08.evidence-acceptance.v1',
 completedAt:new Date().toISOString(),
 originalGate:'No uncovered seeded critical canary in tested outbound requests; documented visual, PII, redaction and p95/resource results; at least five independently verified real Chrome trials of all three demos.',
 evaluationEvidenceComplete:true,
 visualProductQualityAccepted:modelQualityAccepted&&selectiveUtilityAccepted,
 publicReleaseReady:false,
 evidence:{
  controlledDOM:{runs:40,passed:40,annotatedBoxes:dom.summary.geometry.tp,
    postInspectedLabels:true,notModelAccuracy:true},
  realPrivateBrowserUI:{cases:13,groundTruthControls:43,tp:ui.summary.tp,
    fp:ui.summary.fp,fn:ui.summary.fn,precision:ui.summary.precision,
    recall:ui.summary.recall,p95Ms:ui.summary.timings.p95Ms},
  candidateResearch:{tp:ui.summary.researchOnlyCommunityONNX.tp,
    fp:ui.summary.researchOnlyCommunityONNX.fp,fn:ui.summary.researchOnlyCommunityONNX.fn,
    p95Ms:ui.summary.researchOnlyCommunityONNX.timings.p95Ms,
    notProduction:true,provenanceVerified:false},
  actualOutgoingJpeg:{rounds:5,allSevenLabelledInteriorsOpaque:true,
    selectivePreservationPassed:privacy.selectivePreservation.passed,
    selectivePreservationFailed:privacy.selectivePreservation.failed},
  fiveRunChrome:{public:modes.public.wallClockMs,form:modes.form.wallClockMs,
    visual:modes.visual.wallClockMs,publicDomOnly:modes['public-dom'].wallClockMs,
    visualControllerSemanticStatus:'PARTIAL'},
  stageP95Ms:{privateWorker:privacy.stageTimings,wholeTaskPublic:modes.public.stageSamples,
    wholeTaskVisual:modes.visual.stageSamples},
  resourceUpperBound:{dedicatedBrowserWorkingSetP95MiB:
    privacy.timings.aggregateDedicatedBrowserWorkingSetMiBUpperBound.p95Ms,
    dedicatedBrowserCpuP95PercentOfOneCore:
    privacy.timings.activeAggregateCpuPercentOfOneCore.p95Ms,
    extensionOnlyAttribution:false},
  egress:{tasks:4,plannerPosts:egress.plannerPosts,metricsPosts:egress.metricsPosts,
    nativeV2Proofs:egress.genuineV2Proofs,uncoveredSeededCanaries:0,
    unexpectedObservedPrivateWorkerPosts:0,allBrowserEgressExhaustivelyProven:false}
 },
 nonPassingQualityFindings:[
  ...(!modelQualityAccepted?['PINNED_UI_MODEL_RECALL_UNACCEPTED']:[]),
  ...(!selectiveUtilityAccepted?['LARGE_IMAGE_SELECTIVE_PRESERVATION_UNACCEPTED']:[]),
  'MODEL_CANDIDATE_PROVENANCE_UNVERIFIED','LIVE_FIREFOX_NOT_TESTED'
 ],
 nextPhaseRule:'Phase 9 may document/package the evaluated prototype, but must not call the visual detector accurate, selective masking usable on the larger fixture, Firefox live-compatible, or public-store-ready until independently established.'
};
await writeFile(new URL('../runtime/phase-08-acceptance-gate.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({evaluationEvidenceComplete:report.evaluationEvidenceComplete,
 visualProductQualityAccepted:report.visualProductQualityAccepted,
 publicReleaseReady:report.publicReleaseReady,nonPassingQualityFindings:report.nonPassingQualityFindings}));
