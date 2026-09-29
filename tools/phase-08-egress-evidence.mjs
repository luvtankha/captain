// Phase-8 reproducible scoped live private-worker egress evidence. This wraps
// the real CDP audit while persisting ONLY reviewed numeric and fixed fields.
// Child diagnostic text and any unexpected POST body are never saved/printed.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url));
const child=spawnSync(process.execPath,['tools/phase-07-live-egress.mjs','--visual-grounding'],{
  cwd:root,windowsHide:true,encoding:'utf8',timeout:360000,maxBuffer:8192
});
assert.equal(child.status,0,'Scoped actual private-worker egress audit failed.');
assert.equal(child.error,undefined,'Scoped actual private-worker egress audit timed out.');
const observed=JSON.parse(child.stdout);
assert.ok(observed&&typeof observed==='object'&&!Array.isArray(observed));
const keys=['scope','syntheticTasksVerified','visualGroundingVerified','visualControllerSemanticStatus',
  'visualChoiceIndependentlyVerified','plannerPosts','metricsPosts','syntheticCanaryClasses',
  'genuineV2Proofs','completePostBodiesChecked','unexpectedPrivateWorkerPosts',
  'rawFixtureCanaryObservedOutbound','noPersonalData'];
assert.deepEqual(Object.keys(observed).sort(),keys.sort(),'Unreviewed egress report field.');
assert.equal(observed.scope,'verified disposable browser; real private-worker CDP network events');
assert.equal(observed.syntheticTasksVerified,4);
assert.equal(observed.visualGroundingVerified,true);
assert.equal(observed.visualControllerSemanticStatus,'PARTIAL');
assert.equal(observed.visualChoiceIndependentlyVerified,true);
assert.ok(Number.isSafeInteger(observed.plannerPosts)&&observed.plannerPosts>=8);
assert.ok(Number.isSafeInteger(observed.metricsPosts)&&observed.metricsPosts>=4);
assert.equal(observed.syntheticCanaryClasses,7);
assert.ok(Number.isSafeInteger(observed.genuineV2Proofs)&&observed.genuineV2Proofs>=8);
assert.equal(observed.completePostBodiesChecked,true);
assert.equal(observed.unexpectedPrivateWorkerPosts,0);
assert.equal(observed.rawFixtureCanaryObservedOutbound,false);
assert.equal(observed.noPersonalData,true);
const report={schema:'captain.original-phase-08.scoped-private-worker-egress.v1',
  ...Object.fromEntries(keys.map(key=>[key,observed[key]])),
  note:'Four synthetic tasks, not exhaustive interception of all browser or OS processes.',
  completedAt:new Date().toISOString(),passed:true};
await mkdir(new URL('../runtime/',import.meta.url),{recursive:true});
await writeFile(new URL('../runtime/phase-08-scoped-egress.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({passed:report.passed,syntheticTasksVerified:report.syntheticTasksVerified,
  plannerPosts:report.plannerPosts,metricsPosts:report.metricsPosts,
  genuineV2Proofs:report.genuineV2Proofs,unexpectedPrivateWorkerPosts:0}));
