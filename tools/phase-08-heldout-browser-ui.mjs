// A NEW frozen synthetic UI screen corpus in the real private Chrome
// extension, tested with the ACTUAL SHA-pinned ONNX model. Source screenshots,
// raw model predictions and incidental text stay inside the private extension
// controller/worker; Node receives ONLY numeric TP/FP/FN/IoU/latency and enums.
// No model selection or post-hoc truth relabelling. This is NOT real-web recall.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { cdp, debugJson, evaluate, extensionPath, findSession } from './reload-in-place.mjs';
import { summarize, rates } from './phase-08-score.mjs';
import { EXPECTED_SHA } from './phase-06-real-inference.mjs';

const variants=Object.freeze(['light','dark','zoom125','zoom75','scroll','shadow','iframe','dynamic','raster','negative','adversarial','person','canvas']);
const expectedCounts=Object.freeze({light:5,dark:5,zoom125:5,zoom75:5,scroll:5,shadow:2,iframe:2,dynamic:6,raster:5,negative:0,adversarial:1,person:1,canvas:1});
const CANDIDATE_SHA='ee3cb8e8f527b1f2a18e9553d03dc8a08de21bd8b5423a505dc014c8d107f2d0';
const prefix='http://127.0.0.1:4317/phase-08-heldout.html?case=';
const browser=await debugJson('/json/version');
const {extensions=[]}=await cdp(browser.webSocketDebuggerUrl,'Extensions.getExtensions');
const installed=extensions.find(item=>item.path?.toLowerCase()===extensionPath.toLowerCase());
assert.ok(installed?.id,'The exact CAPTAIN extension is not installed.');
const session=await findSession(installed.id);
assert.ok(session?.controller&&Number.isSafeInteger(session.windowId));
const preflight=await evaluate(session.controller,`(async()=>{
 const me=await chrome.tabs.getCurrent(),tabs=await chrome.tabs.query({windowId:me.windowId});
 return {private:me.incognito,windowId:me.windowId,tabs:tabs.map(t=>({private:t.incognito,url:t.url}))};
})()`);
assert.equal(preflight?.private,true);assert.equal(preflight?.windowId,session.windowId);
const allowed=new Set(['about:blank','http://127.0.0.1:4317/privacy-fixture.html',
 'http://127.0.0.1:4317/visual-fixture.html','http://127.0.0.1:4317/demo.html',
 'http://127.0.0.1:4317/demo.html?q=laptop']);
assert.ok(preflight.tabs.every(t=>t.private&&(
  allowed.has(t.url)||t.url?.startsWith(prefix)&&variants.some(k=>t.url===prefix+k)||
  /^http:\/\/127\.0\.0\.1:4317\/benchmark\.html\?case=[a-z-]+$/.test(t.url)||
  t.url?.startsWith(`chrome-extension://${installed.id}/`))),
 'Unreviewed tab in the exact private profile; no model test ran.');
const report={schema:'captain.phase08.heldout-browser-ui.v1',
 scope:'Thirteen locally synthetic Chrome screenshots, including three additional variants introduced AFTER the research-only shape baseline implementation; actual pinned extension ONNX/WASM, independent page-owned boxes, private screenshot/inference; no real-web representativeness',
 originalProductionConfidence:.75,matchIoU:.5,checkpointSha256:EXPECTED_SHA,
 declaredCases:variants,attempted:0,cases:[]};
let owned, failureClass=null, failureStage='SETUP';
try{
 owned=await evaluate(session.controller,`chrome.tabs.create({windowId:${session.windowId},url:'about:blank',active:true})
 .then(t=>({id:t.id,private:t.incognito,windowId:t.windowId}))`,30000);
 assert.equal(owned?.private,true);assert.equal(owned.windowId,session.windowId);
 for(const kind of variants){
  failureStage='FIXTURE_NAVIGATION';
  const url=prefix+kind;
  await evaluate(session.controller,`chrome.tabs.update(${owned.id},{url:${JSON.stringify(url)},active:true})`,30000);
  failureStage='FIXTURE_READY';
  let ready=false;
  for(let i=0;i<60;i++){
   try{ready=await evaluate(session.controller,`(async()=>{
    const t=await chrome.tabs.get(${owned.id});
    if(!t.incognito||t.windowId!==${session.windowId}||t.url!==${JSON.stringify(url)}||
       t.status!=='complete'||t.pendingUrl)return false;
    return (await chrome.tabs.sendMessage(t.id,{type:'READINESS'}))?.ready===true;
   })()`,30000);}catch{}
   if(ready)break;await new Promise(resolve=>setTimeout(resolve,120));
  }
  assert.equal(ready,true,'Synthetic page not ready: '+kind);
  failureStage='PRIVATE_MODEL_EVALUATION';
  // All image, model boxes, independent geometry, and math remain within
  // the private controller. Do not return raw predictions or text to Node.
  const outcome=await evaluate(session.controller,`(async()=>{
   const target=await chrome.tabs.get(${owned.id});
   if(!target.incognito||target.windowId!==${session.windowId}||
      target.url!==${JSON.stringify(url)}||target.pendingUrl||target.status!=='complete'||
      (await chrome.tabs.query({windowId:target.windowId,active:true}))[0]?.id!==target.id)
     throw Error('Synthetic page identity failed');
   const label=()=>chrome.scripting.executeScript({target:{tabId:target.id},world:'MAIN',func:()=>{
     if(!window.__CAPTAIN_HELDOUT__||window.__CAPTAIN_HELDOUT__.version!==1)return null;
     if(window.__CAPTAIN_HELDOUT__.kind==='scroll')
       document.querySelector('[data-eval-control]')?.scrollIntoView({block:'end'});
     const collect=(root,ox=0,oy=0)=>[...root.querySelectorAll('[data-eval-control]')].map(n=>{
      const r=n.getBoundingClientRect();return {x1:r.left+ox,y1:r.top+oy,x2:r.right+ox,y2:r.bottom+oy};
     }).filter(b=>b.x2>b.x1&&b.y2>b.y1&&b.x2>0&&b.y2>0&&b.x1<innerWidth&&b.y1<innerHeight);
     let boxes=collect(document),frame=document.querySelector('iframe'),host=document.querySelector('#host');
     if(host?.shadowRoot)boxes.push(...collect(host.shadowRoot));
     if(frame?.contentDocument){const r=frame.getBoundingClientRect();
       boxes.push(...collect(frame.contentDocument,r.x,r.y));}
     return {kind:window.__CAPTAIN_HELDOUT__.kind,boxes,
       viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio}};
   }}).then(x=>x?.[0]?.result||null);
   // No screenshot permitted if expected test-label shape is absent.
   let first;
   for(let i=0;i<40;i++){
     first=await label();
     if(first?.boxes.length===${expectedCounts[kind]})break;
     await new Promise(resolve=>setTimeout(resolve,120));
   }
   if(!first||first.kind!==${JSON.stringify(kind)}||first.boxes.length!==${expectedCounts[kind]}||
      first.boxes.some(b=>Object.values(b).some(n=>!Number.isFinite(n))))throw Error('Synthetic ground truth missing');
   const hidden=await chrome.tabs.sendMessage(target.id,{type:'CAPTURE_PANEL',mode:'hide'});
   if(hidden?.ok!==true)throw Error('Cannot hide test panel');
   try{
    const shot=await chrome.tabs.captureVisibleTab(target.windowId,{format:'jpeg',quality:82});
    if(typeof shot!=='string'||!shot.startsWith('data:image/jpeg;base64,'))throw Error('Private screenshot unavailable');
    const second=await label();
    if(JSON.stringify(first)!==JSON.stringify(second))throw Error('Synthetic geometry changed during capture');
    const blob=await (await fetch(shot)).blob();
    const runner=new Worker(chrome.runtime.getURL('phase-06-live-worker.js'));
    const lease={documentToken:'synthetic-evaluation-1',observationId:'synthetic-evaluation-2',
      domRevision:1,geometryRevision:1};
    const controls=first.boxes.map((b,i)=>({ref:'c'+(i+1),source:'dom',visible:true,enabled:true,
      sensitive:false,lease,box:{x:b.x1,y:b.y1,width:b.x2-b.x1,height:b.y2-b.y1}}));
    let result;
    try{result=await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{runner.terminate();reject(Error('Private UI inference deadline'));},30000);
      runner.onmessage=e=>{clearTimeout(timer);resolve(e.data)};
      runner.onerror=()=>{clearTimeout(timer);reject(Error('Private UI inference failure'))};
      runner.postMessage({blob,lease,controls,viewport:{width:first.viewport.width,
        height:first.viewport.height,devicePixelRatio:first.viewport.dpr}});
    });}finally{runner.terminate()}
    if(result?.ok!==true||result.modelSha256!==${JSON.stringify(EXPECTED_SHA)}||
      result.candidateSha256!==${JSON.stringify(CANDIDATE_SHA)}||
      !Array.isArray(result.boxes)||result.boxes.length!==result.count||
      !Array.isArray(result.shapeBoxes)||!Number.isSafeInteger(result.shapeMs)||
      !Array.isArray(result.candidateBoxes)||!Number.isSafeInteger(result.candidateMs))
      throw Error('Pinned model/isolated pixel baseline response unavailable');
    // Model output boxes are source pixels; original labels are CSS pixels.
    const bw=result.width, bh=result.height;
    if(!Number.isSafeInteger(bw)||!Number.isSafeInteger(bh)||bw<1||bh<1)throw Error('Model dimensions missing');
    const x=bw/first.viewport.width,y=bh/first.viewport.height;
    if(!Number.isFinite(x)||!Number.isFinite(y)||x<=0||y<=0)throw Error('Screenshot scale invalid');
    const truth=first.boxes.map(b=>({x1:b.x1*x,y1:b.y1*y,x2:b.x2*x,y2:b.y2*y}));
    const overlap=(a,b)=>{const width=Math.max(0,Math.min(a.x2,b.x2)-Math.max(a.x1,b.x1)),
      height=Math.max(0,Math.min(a.y2,b.y2)-Math.max(a.y1,b.y1)),areaA=(a.x2-a.x1)*(a.y2-a.y1),
      areaB=(b.x2-b.x1)*(b.y2-b.y1),intersection=width*height;
      return areaA+areaB>intersection?intersection/(areaA+areaB-intersection):0;};
    const score=boxes=>{
     const pairs=boxes.flatMap((box,di)=>truth.map((t,ti)=>({di,ti,iou:overlap(box,t)})))
       .filter(p=>p.iou>=.5).sort((a,b)=>b.iou-a.iou);
     const detected=new Set(),matched=new Set(),ious=[];
     for(const pair of pairs){if(detected.has(pair.di)||matched.has(pair.ti))continue;
       detected.add(pair.di);matched.add(pair.ti);ious.push(pair.iou)}
     return {tp:matched.size,fp:boxes.length-detected.size,fn:truth.length-matched.size,
       meanMatchedIoU:ious.length?Math.round(10000*ious.reduce((a,b)=>a+b,0)/ious.length)/10000:null};
    };
    const original=score(result.boxes),shape=score(result.shapeBoxes),candidate=score(result.candidateBoxes);
    return {ok:true,truthCount:truth.length,predictedCount:result.count,
      ...original,
      shapeBaseline:{...shape,proposalCount:result.shapeBoxes.length,elapsedMs:result.shapeMs,
        note:'Research-only classical image contours; not trained UI-model output, not used for production cN or privacy release.'},
      communityCandidate:{...candidate,proposalCount:result.candidateBoxes.length,elapsedMs:result.candidateMs,
        note:'Research-only SHA-pinned ONNX conversion; source-weight lineage and redistribution terms unverified; never used for production actions or egress.'},
      elapsedMs:Math.round(result.elapsedMs),modelVerified:true,
      fusionBlackout:result.fusion?.fullBlackout===true,
      boxesReturnedToNode:false,shapeBoxesReturnedToNode:false,rawScreenshotReturnedToNode:false};
   }finally{
    const restored=await chrome.tabs.sendMessage(target.id,{type:'CAPTURE_PANEL',mode:'restore'});
    if(restored?.ok!==true)throw Error('Synthetic panel restore failed');
   }
  })()`,70000);
  assert.equal(outcome?.ok,true);assert.equal(outcome.truthCount,expectedCounts[kind]);
  assert.equal(outcome.modelVerified,true);assert.equal(outcome.rawScreenshotReturnedToNode,false);
  assert.equal(outcome.boxesReturnedToNode,false);
  assert.equal(outcome.shapeBoxesReturnedToNode,false);
  assert.ok(Number.isSafeInteger(outcome.tp)&&Number.isSafeInteger(outcome.fp)&&Number.isSafeInteger(outcome.fn));
  report.cases.push({case:kind,...outcome});report.attempted++;
  console.log(JSON.stringify({case:kind,tp:outcome.tp,fp:outcome.fp,fn:outcome.fn,
    meanMatchedIoU:outcome.meanMatchedIoU,elapsedMs:outcome.elapsedMs,
    shape:outcome.shapeBaseline,candidate:outcome.communityCandidate,
    fusionBlackout:outcome.fusionBlackout}));
 }
}catch{
 // Private error details can include incidental page/OCR values: emit only
 // a fixed failure class and keep an earlier FULL audit untouched.
 failureClass='PRIVATE_BROWSER_ACCEPTANCE_FAILED';
}finally{
 if(owned?.id)try{await evaluate(session.controller,`(async()=>{
  const t=await chrome.tabs.get(${owned.id});if(t.incognito&&t.windowId===${session.windowId}&&
   (t.url==='about:blank'||t.url?.startsWith(${JSON.stringify(prefix)})))await chrome.tabs.remove(t.id);
  return true;
 })()`)}catch{}
 const agg=report.cases.reduce((s,x)=>({tp:s.tp+x.tp,fp:s.fp+x.fp,fn:s.fn+x.fn}),{tp:0,fp:0,fn:0});
 const shape=report.cases.reduce((s,x)=>({tp:s.tp+x.shapeBaseline.tp,fp:s.fp+x.shapeBaseline.fp,
   fn:s.fn+x.shapeBaseline.fn}),{tp:0,fp:0,fn:0});
 const candidate=report.cases.reduce((s,x)=>({tp:s.tp+x.communityCandidate.tp,fp:s.fp+x.communityCandidate.fp,
   fn:s.fn+x.communityCandidate.fn}),{tp:0,fp:0,fn:0});
 report.summary={...rates(agg),complete:report.cases.length===variants.length,
   timings:summarize(report.cases.map(x=>x.elapsedMs)),
   researchOnlyImageContours:{...rates(shape),timings:summarize(report.cases.map(x=>x.shapeBaseline.elapsedMs))},
   researchOnlyCommunityONNX:{sha256:CANDIDATE_SHA,...rates(candidate),
     timings:summarize(report.cases.map(x=>x.communityCandidate.elapsedMs)),
     notProduction:true,redistributionProvenanceVerified:false},
   modelUtilityEstablished:agg.tp>0&&agg.fn===0&&agg.fp===0,
   meaning:'Complete means all declared private-browser cases executed; modelUtilityEstablished=false is an observed model failure, not a passing visual quality gate.'};
 report.finishedAt=new Date().toISOString();
 report.failureClass=failureClass;
 report.failureStage=failureClass ? failureStage : null;
 await mkdir(new URL('../runtime/',import.meta.url),{recursive:true});
 const destination=report.summary.complete && !failureClass ?
  '../runtime/phase-08-heldout-browser-ui.json' : '../runtime/phase-08-heldout-browser-ui-incomplete.json';
 await writeFile(new URL(destination,import.meta.url),JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify({scope:report.scope,attempted:report.attempted,summary:report.summary,
  failureClass,failureStage:report.failureStage,completeAuditPreserved:destination.includes('-incomplete.') }));
}
if(!report.summary.complete||failureClass)process.exitCode=1;
