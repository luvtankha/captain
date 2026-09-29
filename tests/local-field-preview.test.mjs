import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const worker = await readFile(new URL('../extension/service-worker.js', import.meta.url), 'utf8');
const content = await readFile(new URL('../extension/content-script.js', import.meta.url), 'utf8');
const helperCode = worker.slice(worker.indexOf('function validLocalFieldSnapshot('), worker.indexOf('async function captureLocalFieldPreview('));
const snapshot = boxes => ({ documentToken:'test-document', domRevision:1, geometryRevision:1,
  viewport:{width:1000,height:800,devicePixelRatio:1,scrollX:0,scrollY:0},boxes });
function harness() {
  const calls = [], sent = [];
  let current = snapshot([]), closed = 0;
  const context = vm.createContext({
    console, Uint8Array, btoa, fetch: async () => ({blob: async () => new Blob(['raw'])}),
    createImageBitmap: async () => ({width:1000,height:800,close(){closed++;}}),
    OffscreenCanvas: class {
      getContext() { return { drawImage:()=>calls.push('draw'),fillRect:(...rect)=>calls.push(rect) }; }
      async convertToBlob(options) { assert.equal(options.type,'image/png'); return new Blob(['masked']); }
    },
    chrome:{tabs:{sendMessage:async()=>current}}, assertCaptureTab:async()=>{},
    send:async(id,message)=>{sent.push(message);return {ok:true};}
  });
  vm.runInContext(helperCode,context);
  return {context,calls,sent,setCurrent(value){current=value;},get closed(){return closed;}};
}
const raw = 'data:image/jpeg;base64,dGVzdA==';

test('local screenshot draws public pixels then blacks out only bounded fields',async()=>{
  const h=harness(), s=snapshot([{x:50,y:100,width:200,height:40,kind:'PASSWORD'}]);
  const result=await h.context.renderLocalFieldPreview(raw,s);
  assert.match(result,/^data:image\/png;base64,/);
  assert.deepEqual(h.calls,['draw',[48,98,204,44]]);
  assert.equal(h.closed,1);
});
test('no sensitive fields means no blackout, not a whole-frame fallback',async()=>{
  const h=harness(); await h.context.renderLocalFieldPreview(raw,snapshot([]));
  assert.deepEqual(h.calls,['draw']);
});
test('raster, background and unknown regions cannot become local field masks',async()=>{
  for(const kind of ['RASTER_CONTENT','BACKGROUND_IMAGE','UNKNOWN']) {
    const h=harness();
    await assert.rejects(h.context.renderLocalFieldPreview(raw,snapshot([{x:0,y:0,width:1000,height:800,kind}])));
    assert.deepEqual(h.calls,[]);
  }
});
test('changed geometry discards the screenshot without publishing it',async()=>{
  const h=harness(), before=snapshot([]); h.setCurrent({...before,geometryRevision:2});
  await assert.rejects(h.context.publishLocalFieldPreview({id:1},raw,before),/changed/);
  assert.deepEqual(h.sent,[]);
});
test('local screenshot has only local display messages and no outgoing image proof',async()=>{
  const h=harness(), s=snapshot([{x:50,y:100,width:200,height:40,kind:'PASSWORD'}]); h.setCurrent(s);
  assert.equal(await h.context.publishLocalFieldPreview({id:1},raw,s),1);
  assert.deepEqual(h.sent.map(m=>m.type),['SHOW_SENSITIVE_REDACTION_NOTICE','SHOW_LOCAL_FIELD_PREVIEW']);
  assert.equal(h.sent[1].localOnly,true); assert.equal(h.sent[1].fullBlackout,false);
  assert.equal(h.sent[1].visualPrivacy,undefined);
  assert.equal(h.sent[1].rawScreenshotTransmitted,false);
});

const fieldCode=content.slice(content.indexOf('  function localFieldSnapshot()'),content.indexOf('  function uninspectableVisualRegions('));
for(const [hint,kind] of [['login','CREDENTIAL'],['full_name','PERSON'],['password','PASSWORD'],['aadhaar','AADHAAR'],['aadhar','AADHAAR'],['PAN','PAN'],['dateOfBirth','DATE_OF_BIRTH'],['street_address','ADDRESS'],['email','EMAIL'],['search','']]) {
  test(`local scan classifies ${hint} without copying values`,()=>{
    const field={tagName:'INPUT',type:'text',name:hint,value:'never copy this'};
    const context=vm.createContext({runtimeAlive:()=>true,privacyReady:true,flushMutations(){},
      controlScopes:()=>[{root:{querySelectorAll:()=>[field]}}],sensitiveTextRegions:()=>[],
      isCaptainNode:()=>false,visible:()=>true,safeLabel:()=>({text:''}),sensitiveInputType:()=>'',textFindings:()=>[],
      topRect:()=>({x:50,y:100,width:200,height:40}),documentToken:'doc',domRevision:1,geometryRevision:1,
      innerWidth:1000,innerHeight:800,devicePixelRatio:1});
    vm.runInContext(fieldCode,context);
    const result=context.localFieldSnapshot();
    assert.equal(result.boxes.length,kind?1:0);
    if(kind) assert.equal(result.boxes[0].kind,kind);
    assert.ok(!JSON.stringify(result).includes(field.value));
  });
}
