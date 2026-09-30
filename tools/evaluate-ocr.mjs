import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {cdp,debugJson,evaluate,extensionPath,findSession} from './reload-in-place.mjs';
import {summarize} from './phase-08-score.mjs';
import {sourceFingerprint} from './evidence-provenance.mjs';

// Fixed corpus and thresholds are declared before any inference runs.
const cases=['Arial','Times New Roman'].flatMap(font=>[14,20,28].flatMap(size=>
  [1,1.25].flatMap(zoom=>['light','dark'].map(theme=>({font,size,zoom,theme})))));
const report={schema:'captain.local-ocr-evaluation.v1',generatedAt:new Date().toISOString(),
  sourceFingerprint:await sourceFingerprint(),
  scope:'24 synthetic Latin-text rasters rendered in the extension, not live website screenshots or multilingual OCR. Fresh production OCR worker per case, including asset verification and teardown.',
  language:'eng',thresholds:{maxCharacterErrorRate:.05,maxWordErrorRate:.1},declaredCases:cases.length,cases:[]};
let stage='DISCOVERY';
try {
  const browser=await debugJson('/json/version');
  const installed=(await cdp(browser.webSocketDebuggerUrl,'Extensions.getExtensions')).extensions
    .find(e=>e.path?.toLowerCase()===extensionPath.toLowerCase());
  assert.ok(installed?.id);
  const session=await findSession(installed.id);assert.ok(session?.controller);
  const preflight=await evaluate(session.controller,`(async()=>{
    const me=await chrome.tabs.getCurrent(),s=await chrome.runtime.sendMessage({type:'GET_STATE'});
    return {incognito:me.incognito,status:s.status};})()`);
  assert.equal(preflight.incognito,false);
  assert.ok(!['running','waiting_privacy_consent','waiting_human'].includes(preflight.status));
  for(const specimen of cases) {
    stage='LOCAL_OCR';
    // Count the attempted case even when transport or worker startup fails.
    report.cases.push({...specimen,ok:false});
    const result=await evaluate(session.controller,`(async()=>{
      const worker=new Worker(chrome.runtime.getURL('readiness-ocr-worker.js'));
      try{return await new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>{worker.terminate();reject(Error('OCR audit timeout'));},55000);
        worker.onmessage=e=>{clearTimeout(timer);resolve(e.data)};
        worker.onerror=()=>{clearTimeout(timer);reject(Error('OCR audit unavailable'))};
        worker.postMessage(${JSON.stringify(specimen)});
      });}finally{worker.terminate()}
    })()`,60000);
    const valid=result?.ok===true&&['characterErrors','characters','wordErrors','words','elapsedMs']
      .every(k=>Number.isSafeInteger(result[k])&&result[k]>=0)&&result.characters>0&&result.words>0;
    report.cases[report.cases.length-1]={...specimen,ok:valid,...(valid?{
      characterErrors:result.characterErrors,characters:result.characters,
      wordErrors:result.wordErrors,words:result.words,elapsedMs:result.elapsedMs}:{} )};
    console.log(JSON.stringify(report.cases.at(-1)));
  }
} catch {report.failureStage=stage;}
const successful=report.cases.filter(c=>c.ok),sum=k=>successful.reduce((n,c)=>n+c[k],0);
const characters=sum('characters'),words=sum('words');
report.summary={attempted:report.cases.length,completed:successful.length,
  failedAttempts:report.cases.length-successful.length,unattempted:cases.length-report.cases.length,
  failed:cases.length-successful.length,characterErrors:sum('characterErrors'),characters,
  wordErrors:sum('wordErrors'),words,characterErrorRate:characters?sum('characterErrors')/characters:null,
  wordErrorRate:words?sum('wordErrors')/words:null,timings:summarize(successful.map(c=>c.elapsedMs))};
report.summary.aggregateWithinThreshold=successful.length===cases.length&&
  report.summary.characterErrorRate<=report.thresholds.maxCharacterErrorRate&&
  report.summary.wordErrorRate<=report.thresholds.maxWordErrorRate;
report.summary.casesWithinThreshold=successful.filter(c=>c.characterErrors/c.characters<=report.thresholds.maxCharacterErrorRate&&
  c.wordErrors/c.words<=report.thresholds.maxWordErrorRate).length;
report.summary.qualityGatePassed=report.summary.aggregateWithinThreshold&&report.summary.casesWithinThreshold===cases.length;
report.finishedAt=new Date().toISOString();
await mkdir(new URL('../runtime/',import.meta.url),{recursive:true});
await writeFile(new URL('../runtime/ocr-evaluation.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({summary:report.summary}));
if(!report.summary.qualityGatePassed)process.exitCode=1;
