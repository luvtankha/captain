import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
const code = await readFile(new URL('../extension/reference/privacy-bridge.js', import.meta.url), 'utf8');
function bridge() {
  const ctx = { Number, Array }; ctx.globalThis = ctx;
  vm.runInNewContext(code, ctx);
  return ctx.CaptainTrueSight;
}
const words = [
  { text:'private@example.test', confidence:99, bbox:{x0:10,y0:10,x1:70,y1:23} },
  { text:'public', confidence:98, bbox:{x0:75,y0:10,x1:90,y1:23} }
];
const base = { words, width:100, height:40, modelVerified:true, complete:true,
  predictions:[{wordIndex:0,label:'EMAIL',score:0.99},{wordIndex:1,label:'O',score:0.99}] };
test('unverified source package cannot activate TrueSight', () => {
  const b=bridge(); assert.equal(b.ready,false); assert.equal(typeof b.detect,'undefined');
});
test('verified, complete local predictions map to opaque PII geometry only', () => {
  const result=bridge().review(base);
  assert.equal(result.fullBlackout,false);
  assert.deepEqual(JSON.parse(JSON.stringify(result.regions)),[{x1:10,y1:10,x2:70,y2:23,kind:'PII'}]);
  assert.doesNotMatch(JSON.stringify(result),/private@example|public|wordIndex|score/);
});
for (const [name, delta] of Object.entries({
  missingWeights:{modelVerified:false}, timeout:{complete:false}, missingPredictions:{predictions:[]},
  lowConfidence:{predictions:[{wordIndex:0,label:'EMAIL',score:0.89},{wordIndex:1,label:'O',score:1}]},
  unknownLabel:{predictions:[{wordIndex:0,label:'UNSEEN',score:1},{wordIndex:1,label:'O',score:1}]},
  outOfOrder:{predictions:[{wordIndex:1,label:'EMAIL',score:1},{wordIndex:0,label:'O',score:1}]},
  badBox:{words:[{...words[0],bbox:{...words[0].bbox,x1:Infinity}},words[1]]},
  lowOCR:{words:[{...words[0],confidence:70},words[1]]},
  unsupportedScript:{words:[{...words[0],text:'नमस्ते'},words[1]]},
  noOCR:{words:[]}, malformedDimensions:{width:0}
})) test(`uncertain ${name} requires full blackout`, () => {
  const result=bridge().review({...base,...delta});
  assert.equal(result.fullBlackout,true); assert.equal(result.regions.length,0);
});
test('bridge wired only into the local worker, not planner or content script', async () => {
  const worker=await readFile(new URL('../extension/vision-worker.js', import.meta.url),'utf8');
  assert.match(worker,/reference\/privacy-bridge\.js/);
  assert.match(worker,/ocrPlan = \{ fullBlackout: true, regions: \[\] \}/);
  assert.doesNotMatch(worker,/visualPrivacy:[\s\S]*CaptainTrueSight/);
});
