import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {configuredOllama, ensureOptionalOllama} from '../tools/optional-ollama.mjs';
import '../extension/readiness-metrics.js';
import {testCategory} from '../tools/evidence-provenance.mjs';

test('evidence categories are exclusive and leave uncategorized tests visible', () => {
  assert.equal(testCategory('privacy-attack.test.mjs'),'privacy-security');
  assert.equal(testCategory('action-binding.test.mjs'),'action-validation');
  assert.equal(testCategory('something-new.test.mjs'),'other-regression');
});

test('OCR quality gate cannot hide one poor case behind a good average', async () => {
  const source=await readFile(new URL('../tools/evaluate-ocr.mjs',import.meta.url),'utf8');
  assert.match(source,/casesWithinThreshold===cases.length/);
  assert.match(source,/successful.length===cases.length/);
});

test('live navigation audit owns its tab and reports handoff separately from navigation', async () => {
  const source=await readFile(new URL('../tools/audit-live-flow.mjs',import.meta.url),'utf8');
  assert.match(source,/let targetId = owned.id/);
  assert.doesNotMatch(source,/let targetId = initial.session/);
  assert.match(source,/expectedCredentialHandoffs:/);
  assert.match(source,/current.requestId===lastRequestId/);
  assert.match(source,/await read\(\).catch\(\(\)=>null\)/);
  assert.match(source,/await checkpoint\(\)/);
  assert.match(source,/BROWSER_CONNECTION_UNAVAILABLE/);
});

test('OCR character and word error rates retain substitutions, deletions and insertions', () => {
  const {distance,recognition}=globalThis.CaptainReadinessMetrics;
  assert.equal(distance('kitten','sitting'),3);
  assert.deepEqual(recognition('a b','a b'),{characterErrors:0,characters:3,wordErrors:0,words:2});
  assert.deepEqual(recognition('a b',''),{characterErrors:3,characters:3,wordErrors:2,words:2});
  assert.equal(recognition('a','a b c').wordErrors,2); // WER may exceed one; never clamp.
  assert.equal(recognition(' a  b ','a b').characterErrors,0);
  assert.throws(()=>recognition('','x'));
});

test('diagnostic workers are excluded from release and vision failure is nonzero', async () => {
  const packaging=await readFile(new URL('../tools/package.mjs',import.meta.url),'utf8');
  for(const file of ['readiness-vision-worker.js','readiness-ocr-worker.js','readiness-metrics.js'])
    assert.ok(packaging.includes(file));
  const vision=await readFile(new URL('../tools/evaluate-vision.mjs',import.meta.url),'utf8');
  assert.match(vision,/if\(!report.summary.qualityGatePassed\|\|failureClass\)process.exitCode=1/);
  assert.doesNotMatch(vision,/CANDIDATE_SHA|candidateBoxes|shapeBaseline/);
  assert.match(vision,/assert.equal\(owned\?\.private,false\)/);
});

test('default deterministic launcher neither probes nor starts Ollama', async () => {
  const forbidden = () => {throw Error('Unnecessary model service');};
  assert.deepEqual(await ensureOptionalOllama({enabled:false,fetchService:forbidden,spawnService:forbidden}),{enabled:false,started:false});
});
test('Ollama starts only for explicit configuration with process override', async () => {
  assert.equal(configuredOllama({}, '# model\nCAPTAIN_OLLAMA_MODEL="local-model"'),true);
  assert.equal(configuredOllama({CAPTAIN_OLLAMA_MODEL:''}, 'CAPTAIN_OLLAMA_MODEL=local-model'),false);
  assert.equal(configuredOllama({}, 'CAPTAIN_VLM_API_KEY=synthetic'),false);
  let starts=0;
  await ensureOptionalOllama({enabled:true,fetchService:async()=>({ok:false}),spawnService:async()=>{starts++;}});
  assert.equal(starts,1);
  await ensureOptionalOllama({enabled:true,fetchService:async()=>({ok:true}),spawnService:async()=>{starts++;}});
  assert.equal(starts,1);
});
test('benchmark uses geometric matching in an owned normal tab, not count accuracy', async () => {
  const old=await readFile(new URL('../tools/benchmark.mjs',import.meta.url),'utf8');
  const current=await readFile(new URL('../tools/phase-08-evaluate.mjs',import.meta.url),'utf8');
  assert.match(old,/import\('\.\/phase-08-evaluate.mjs'\)/);
  assert.doesNotMatch(old,/Math\.min\(expectedElements|shoppingAudit/);
  assert.match(current,/assert.equal\(ownedTab.incognito,false\)/);
  assert.match(current,/matchControls\(truth.controls,observed.elements\)/);
  assert.match(current,/independentHeldOut:false/);
  assert.match(current,/report.status!=='CONTROLLED_CORPUS_PASSED'/);
});
