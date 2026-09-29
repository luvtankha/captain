import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../dashboard/phase-08-heldout.html',import.meta.url),'utf8');
const runner = await readFile(new URL('../tools/phase-08-heldout-browser-ui.mjs',import.meta.url),'utf8');
const worker = await readFile(new URL('../extension/phase-06-live-worker.js',import.meta.url),'utf8');
const server = await readFile(new URL('../server/index.mjs',import.meta.url),'utf8');

test('independently labelled held-out browser fixture includes positive/negative and varied UI surfaces',()=>{
 for (const variant of ['light','dark','zoom125','zoom75','scroll','shadow','iframe','dynamic','raster','negative','adversarial','person','canvas']) {
  assert.ok(html.includes(`'${variant}'`),`missing fixture variant ${variant}`);
  assert.ok(runner.includes(`'${variant}'`),`missing audited variant ${variant}`);
 }
 assert.match(html,/data-eval-control/);
 assert.match(html,/attachShadow\(\{mode:'open'\}\)/);
 assert.match(html,/srcdoc/);
 assert.match(html,/setTimeout\(\(\)=>area\.insertAdjacentHTML/);
 assert.match(runner,/expectedCounts=Object\.freeze/);
 assert.match(runner,/modelUtilityEstablished:/);
 assert.match(server,/"\/phase-08-heldout\.html", "dashboard\/phase-08-heldout\.html"/);
});

test('browser-heldout model audit keeps raw JPEG and model coordinates private, reports bounded metrics only',()=>{
 assert.match(runner,/const shot=await chrome\.tabs\.captureVisibleTab/);
 assert.match(runner,/const runner=new Worker\(chrome\.runtime\.getURL\('phase-06-live-worker\.js'\)\)/);
 assert.match(runner,/boxesReturnedToNode:false,shapeBoxesReturnedToNode:false,/);
 assert.match(runner,/const pairs=boxes\.flatMap/);
 assert.match(runner,/JSON\.stringify\(\{case:kind,tp:outcome\.tp,fp:outcome\.fp,fn:outcome\.fn/);
 assert.doesNotMatch(runner,/console\.log\(shot\)|console\.log\(result\.boxes\)/);
 assert.match(worker,/width: result\.width, height: result\.height/);
 assert.match(worker,/shapeBoxes:proposals\.map\(item=>item\.box\),shapeMs/);
 assert.match(worker,/candidateBoxes:alternative\.boxes,candidateMs,candidateSha256/);
 assert.match(worker,/if \(!tensor\) return originalRun\(input\)/);
 assert.match(runner,/shapeBoxesReturnedToNode:false/);
 assert.match(runner,/researchOnlyCommunityONNX/);
 assert.match(runner,/t\.incognito&&t\.windowId===/);
});

test('experimental pixel baseline is image-only and excluded from release package',async()=>{
 const shape=await readFile(new URL('../extension/controls/ui-shape.js',import.meta.url),'utf8');
 const packager=await readFile(new URL('../tools/package.mjs',import.meta.url),'utf8');
 assert.match(shape,/CLASSICAL|classical/);
 assert.match(shape,/width\*height\*4/);
 assert.doesNotMatch(shape,/querySelector|document\.|fetch\(/);
 assert.match(packager,/'controls\/ui-shape\.js'/);
 assert.match(packager,/join\(dist, 'chrome', 'controls', 'experiments'\)/);
});

test('optional community ONNX study stays private, hash pinned, without planner or production integration',async()=>{
 // Research code exists in the developer checkout, never the clean source ZIP.
 const adapter=await readFile(new URL('../extension/controls/experiments/candidate-adapter.js',import.meta.url),'utf8')
  .catch(error=>{if(error?.code==='ENOENT')return null;throw error;});
 const worker=await readFile(new URL('../extension/vision-worker.js',import.meta.url),'utf8');
 const packager=await readFile(new URL('../tools/package.mjs',import.meta.url),'utf8');
 if(adapter!==null){
 assert.match(adapter,/ee3cb8e8f527b1f2a18e9553d03dc8a08de21bd8b5423a505dc014c8d107f2d0/);
 assert.match(adapter,/SHA-256/);
 assert.match(adapter,/Research model unavailable/);
 assert.match(adapter,/executionProviders:\['wasm'\]/);
 assert.doesNotMatch(adapter,/chrome\.tabs|chrome\.runtime|postMessage|fetch\(['"]http/);
 }
 assert.doesNotMatch(worker,/CandidateResearch|omniparser-community-int8/);
 assert.match(packager,/await rm\(join\(dist, 'chrome', 'controls', 'experiments'\)/);
});
