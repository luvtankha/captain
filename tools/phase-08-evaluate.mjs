// Original Phase 8 controlled labelled geometry audit. The independent DOM
// fixture oracle is NOT a visual-model benchmark or photographic-face study.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { cdp, debugJson, evaluate, extensionPath, findSession } from './reload-in-place.mjs';
import { matchControls, matchKinds, summarize, rates } from './phase-08-score.mjs';
import {sourceFingerprint} from './evidence-provenance.mjs';

const basis=JSON.parse(await readFile(new URL('../benchmarks/groundTruth.json',import.meta.url),'utf8'));
const corpus=JSON.parse(await readFile(new URL('../benchmarks/phase-08-corpus.json',import.meta.url),'utf8'));
const samples=Object.keys(basis.cases).map(id=>({id,variant:'base',
  split:'previously-inspected'}))
  .concat(corpus.variants.map(v=>({id:v.case,variant:v.variant,split:'previously-inspected'})));
assert.equal(new Set(samples.map(s=>s.id+'/'+s.variant)).size,samples.length);
assert.ok(samples.every(s=>basis.cases[s.id]));
const report={schema:'captain.normal-window.geometry-evaluation.v2',generatedAt:new Date().toISOString(),
  sourceFingerprint:await sourceFingerprint(),
  status:'PARTIAL',scope:'Controlled synthetic DOM geometry/private-kind count audit; not ONNX model or pixel-mask accuracy',cases:[]};
let ownedTab,session,controller,stage='initialization';
const fixtureUrl=id=>`http://127.0.0.1:4317/benchmark.html?case=${id}`;
try{
  stage='companion-health';
  const health=await fetch('http://127.0.0.1:4317/health',{signal:AbortSignal.timeout(3000)});
  assert.equal(health.ok,true);
  const browser=await debugJson('/json/version');
  stage='exact-extension-discovery';
  const installed=(await cdp(browser.webSocketDebuggerUrl,'Extensions.getExtensions')).extensions
    .find(e=>e.path?.toLowerCase()===extensionPath.toLowerCase());
  assert.ok(installed?.id,'Exact workspace extension not found.');
  session=await findSession(installed.id);assert.ok(session?.controller&&Number.isSafeInteger(session.windowId));
  controller=session.controller;
  stage='normal-window-preflight';
  const preflight=await evaluate(controller,`(async()=>{const me=await chrome.tabs.getCurrent();
    return {incognito:me.incognito,windowId:me.windowId};})()`);
  assert.equal(preflight.incognito,false);assert.equal(preflight.windowId,session.windowId);
  const state=await evaluate(controller,`chrome.runtime.sendMessage({type:'GET_STATE'}).then(s=>({status:s.status}))`);
  assert.ok(!['running','waiting_privacy_consent','waiting_human'].includes(state.status),'Do not interrupt an active task.');
  stage='create-owned-tab';
  ownedTab=await evaluate(controller,`chrome.tabs.create({windowId:${session.windowId},
    url:'about:blank',active:true}).then(t=>({id:t.id,incognito:t.incognito,windowId:t.windowId}))`);
  assert.equal(ownedTab.incognito,false);assert.equal(ownedTab.windowId,session.windowId);
  for(const sample of samples){
    stage='fixture-navigation';
    const start=performance.now(),url=fixtureUrl(sample.id);
    await evaluate(controller,`chrome.tabs.update(${ownedTab.id},{url:${JSON.stringify(url)},active:true})`);
    let ready=false;
    for(let i=0;i<50;i++){
      try{ready=await evaluate(controller,`(async()=>{const t=await chrome.tabs.get(${ownedTab.id});
        return !t.incognito&&t.windowId===${session.windowId}&&t.url===${JSON.stringify(url)}&&
          t.status==='complete'&&!t.pendingUrl&&
          (await chrome.tabs.sendMessage(t.id,{type:'READINESS'}))?.ready===true;})()`);}catch{}
      if(ready)break;await new Promise(r=>setTimeout(r,100));
    }
    assert.equal(ready,true,'Fixture unreadable: '+sample.id);
    stage='fixture-annotations';
    // The page's own DOM provides independent geometry labels. Neither page
    // text nor input values are returned from the evaluator's browser context.
    const truth=await evaluate(controller,`chrome.scripting.executeScript({
      target:{tabId:${ownedTab.id}},world:'MAIN',func:variant=>{
        const label=window.__CAPTAIN_BENCHMARK__;if(!label)return {ok:false};
        if(variant==='dark'){
          document.body.style.background='#10121a';const main=document.querySelector('main');
          main.style.background='#141923';main.style.color='#f6f8ff';
        }else if(variant==='zoom125')document.documentElement.style.zoom='125%';
        else if(variant==='zoom75')document.documentElement.style.zoom='75%';
        else if(variant==='scroll-bottom')scrollTo(0,document.documentElement.scrollHeight);
        else if(variant!=='base')return {ok:false};
        const controls=[...document.querySelectorAll('#case input,#case select,#case button,#case a')]
          .filter(node=>{const r=node.getBoundingClientRect(),s=getComputedStyle(node);
            return r.width>0&&r.height>0&&r.bottom>0&&r.right>0&&
              r.top<innerHeight&&r.left<innerWidth&&s.display!=='none'&&s.visibility!=='hidden';})
          .map(node=>{const r=node.getBoundingClientRect();return {tag:node.tagName.toLowerCase(),
            bbox:{x:r.x,y:r.y,width:r.width,height:r.height}};});
        return {ok:true,id:label.id,declaredElements:label.elements,kinds:label.kinds,controls};
      },args:[${JSON.stringify(sample.variant)}]}).then(x=>x?.[0]?.result)`);
    assert.equal(truth?.ok,true);assert.equal(truth.id,sample.id);
    assert.deepEqual(truth.kinds,basis.cases[sample.id].privateRegions);
    stage='fixture-observation';
    const observeStart=performance.now();let observed;
    try{observed=await evaluate(controller,`chrome.tabs.sendMessage(${ownedTab.id},
      {type:'OBSERVE',captureRequested:true}).then(o=>o?.error?{blocked:true}:{
        blocked:false,elements:(o.elements||[]).map(e=>({tag:e.tag,bbox:e.bbox})),
        kinds:(o.redactionBoxes||[]).map(b=>b.kind),
        canaryAbsent:!/judge@example\\.com|NeverSendThis|483921|ABCDE1234F|123456789012|4111 1111 1111 1111|10 Demo Street|creator@example\\.org|mixed@example\\.com|sk_test_not_real/i.test(o.pageText||''),
        domMs:o.localTiming?.totalDomObservationMs??null})`);}catch{observed={blocked:true};}
    const observationRoundTripMs=Math.round(performance.now()-observeStart);
    const truthCountVerified=sample.variant==='scroll-bottom'||
      truth.controls.length===basis.cases[sample.id].expectedElements;
    const geometry=observed.blocked?null:matchControls(truth.controls,observed.elements);
    const kinds=observed.blocked?null:matchKinds(truth.kinds,observed.kinds);
    const passed=!!truthCountVerified&&!observed.blocked&&observed.canaryAbsent&&
      geometry.fp===0&&geometry.fn===0&&kinds.fp===0&&kinds.fn===0;
    report.cases.push({id:sample.id,variant:sample.variant,split:sample.split,passed,
      blocked:!!observed.blocked,truthCountVerified,groundTruthControls:truth.controls.length,
      detectedControls:observed.elements?.length??null,
      geometry:geometry?{tp:geometry.tp,fp:geometry.fp,fn:geometry.fn,
        matchedMeanIoU:geometry.matches.length?Number((geometry.matches.reduce((sum,m)=>sum+m.iou,0)/geometry.matches.length).toFixed(4)):null}:null,
      privateKindCount:kinds,
      kindAudit:(!observed.blocked && (kinds.fp || kinds.fn)) ? {
        expected:truth.kinds.filter(k=>/^[A-Z_]{2,24}$/.test(k)),
        observed:observed.kinds.map(k=>/^[A-Z_]{2,24}$/.test(k)?k:'UNKNOWN_KIND')
      }:null,
      canaryAbsent:observed.canaryAbsent===true,
      timing:{observationRoundTripMs,domMs:Number.isFinite(observed.domMs)?observed.domMs:null,
        totalFixtureMs:Math.round(performance.now()-start)}});
    console.log(JSON.stringify({id:sample.id,variant:sample.variant,passed,
      geometry:geometry?{tp:geometry.tp,fp:geometry.fp,fn:geometry.fn}:null,
      kinds,observationRoundTripMs}));
  }
  const sum=key=>report.cases.reduce((s,c)=>{
    if(c[key])for(const name of ['tp','fp','fn'])s[name]+=c[key][name];return s;},{tp:0,fp:0,fn:0});
  report.summary={total:report.cases.length,passed:report.cases.filter(c=>c.passed).length,
    failed:report.cases.filter(c=>!c.passed).length,
    independentHeldOut:false,
    geometry:rates(sum('geometry')),privateKindCountAgreement:rates(sum('privateKindCount')),
    observationRoundTrip:summarize(report.cases.map(c=>c.timing.observationRoundTripMs)),
    dom:summarize(report.cases.map(c=>c.timing.domMs).filter(Number.isFinite)),
    syntheticCanaryAbsent:report.cases.every(c=>c.canaryAbsent)};
  report.status=report.summary.failed?'PARTIAL':'CONTROLLED_CORPUS_PASSED';
  console.log(JSON.stringify({summary:report.summary,status:report.status}));
}catch(error){report.status='FAILED';report.failureStage=stage;
  console.error('Phase-8 synthetic evaluation stopped at gate: '+stage);
  process.exitCode=1;
}finally{
  if(controller&&ownedTab?.id)try{await evaluate(controller,`chrome.tabs.get(${ownedTab.id}).then(t=>
    !t.incognito&&t.windowId===${session.windowId}&&
    (t.url==='about:blank'||t.url?.startsWith('http://127.0.0.1:4317/benchmark.html?case='))
      ?chrome.tabs.remove(t.id):false)`);}catch{}
  await mkdir(new URL('../runtime/',import.meta.url),{recursive:true});
  await writeFile(new URL('../runtime/normal-geometry-evaluation.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
}
if(report.status!=='CONTROLLED_CORPUS_PASSED')process.exitCode=1;
