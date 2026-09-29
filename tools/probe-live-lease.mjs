// Privacy-safe live stability probe. It visits two public pages in CAPTAIN's
// dedicated normal browser and samples only lease/revision booleans and counts.
// No screenshot, OCR, page text, field value, bounding box or raw page URL
// query is returned to Node or written to the report.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { cdp, debugJson, evaluate, extensionPath, findSession } from './reload-in-place.mjs';

const sites = [
  { name: 'Amazon India', url: 'https://www.amazon.in/' },
  { name: 'Stack Overflow', url: 'https://stackoverflow.com/questions' },
];
const sampleCount = process.argv.includes('--one') ? 0 : process.argv.includes('--long') ? 18 : 6;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const busy = new Set(['running', 'waiting_privacy_consent', 'waiting_human']);

const browser = await debugJson('/json/version');
const installed = await cdp(browser.webSocketDebuggerUrl, 'Extensions.getExtensions');
const extension = installed.extensions.find(item => item.path?.toLowerCase() === extensionPath.toLowerCase());
assert.ok(extension, 'Run npm run demo first.');
const session = await findSession(extension.id);
assert.ok(session?.controller && Number.isSafeInteger(session.target?.tabId), 'A normal CAPTAIN working tab is required.');
const controller = session.controller;
const readState = () => evaluate(controller, "chrome.runtime.sendMessage({type:'GET_STATE'})");
assert.ok(!busy.has((await readState()).status), 'An existing CAPTAIN task is active; the probe did not interrupt it.');
const tabId = session.target.tabId;

async function waitForReady(site) {
  await evaluate(controller, `chrome.tabs.update(${tabId},{url:${JSON.stringify(site.url)},active:true})`);
  const expected = new URL(site.url).origin + new URL(site.url).pathname;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const reading = await evaluate(controller, `(async()=>{
      try {
        const response=await chrome.tabs.sendMessage(${tabId},{type:'READINESS'});
        const tab=await chrome.tabs.get(${tabId});
        const safe=raw=>{try{const u=new URL(raw);return u.origin+u.pathname}catch{return ''}};
        return {ok:true,url:safe(tab.url),contentUrl:safe(response?.url),ready:response?.ready===true,meaningful:response?.meaningfulContent===true,
          documentBound:typeof response?.documentToken==='string'&&response.documentToken.length>0,
          domRevision:Number.isSafeInteger(response?.domRevision)?response.domRevision:null,
          geometryRevision:Number.isSafeInteger(response?.geometryRevision)?response.geometryRevision:null,
          amazonResultCards:Number.isSafeInteger(response?.amazonResultCards)?response.amazonResultCards:null};
      } catch { return {ok:false}; }
    })()`);
    if (reading?.ok && reading.url === expected && reading.contentUrl === expected &&
        reading.documentBound && reading.ready && reading.meaningful) return reading;
    await wait(300);
  }
  return { ok: false, timedOut: true };
}

async function sampleLease() {
  return evaluate(controller, `(async()=>{
    const safe=raw=>{try{const u=new URL(raw);return u.origin+u.pathname}catch{return ''}};
    const compact=observation=>{
      const lease=observation?.pageMetadata||{};
      const viewport=observation?.viewport||{};
      return {
        valid:!!observation&&typeof lease.documentToken==='string'&&lease.documentToken.length>0&&
          Number.isSafeInteger(lease.domRevision)&&Number.isSafeInteger(lease.geometryRevision)&&
          Array.isArray(observation.redactionBoxes),
        url:safe(observation?.url), domRevision:lease.domRevision??null,
        geometryRevision:lease.geometryRevision??null,
        viewport:{width:viewport.width??null,height:viewport.height??null,dpr:viewport.devicePixelRatio??null},
        boxCount:Array.isArray(observation?.redactionBoxes)?observation.redactionBoxes.length:null,
        // These are opaque local fingerprints. Export only change booleans,
        // never the fingerprints or any page-derived text.
        _documentToken:lease.documentToken||'', _visibleTextHash:lease.visibleTextHash||'',
        _domFingerprint:lease.domFingerprint||'', _boxes:observation?.redactionBoxes||[]
      };
    };
    const compare=(first,next)=>{
      const contained=next._boxes.every(later=>first._boxes.some(prior=>
        later.x>=prior.x&&later.y>=prior.y&&later.x+later.width<=prior.x+prior.width&&later.y+later.height<=prior.y+prior.height));
      return {
        documentChanged:first._documentToken!==next._documentToken,
        domRevisionChanged:first.domRevision!==next.domRevision,
        geometryRevisionChanged:first.geometryRevision!==next.geometryRevision,
        urlChanged:first.url!==next.url,
        viewportChanged:JSON.stringify(first.viewport)!==JSON.stringify(next.viewport),
        visibleTextChanged:first._visibleTextHash!==next._visibleTextHash,
        controlFingerprintChanged:first._domFingerprint!==next._domFingerprint,
        boxCountChanged:first.boxCount!==next.boxCount,
        exactBoxesUnchanged:JSON.stringify(first._boxes)===JSON.stringify(next._boxes),
        laterMasksCoveredByFirst:contained
      };
    };
    try {
      const first=compact(await chrome.tabs.sendMessage(${tabId},{type:'OBSERVE',captureRequested:true}));
      const samples=[];
      for(let index=0;index<${sampleCount};index++){
        await new Promise(resolve=>setTimeout(resolve,650));
        const next=compact(await chrome.tabs.sendMessage(${tabId},{type:'OBSERVE',captureRequested:true}));
        samples.push({index:index+1,valid:next.valid,domRevision:next.domRevision,geometryRevision:next.geometryRevision,
          boxCount:next.boxCount,differenceFromFirst:compare(first,next)});
      }
      return {ok:first.valid,first:{valid:first.valid,url:first.url,domRevision:first.domRevision,geometryRevision:first.geometryRevision,
        viewport:first.viewport,boxCount:first.boxCount},samples};
    } catch { return {ok:false,reason:'local-observation-refused'}; }
  })()`, Math.max(20000, sampleCount * 2500 + 10000));
}

async function samplePacing() {
  return evaluate(controller, `(async()=>{
    const safe=raw=>{try{const u=new URL(raw);return u.origin+u.pathname}catch{return ''}};
    const compact=result=>({
      valid:result?.ok===true&&typeof result.documentToken==='string'&&result.documentToken.length>0&&
        Number.isSafeInteger(result.domRevision)&&Number.isSafeInteger(result.geometryRevision)&&
        Number.isSafeInteger(result.redactionCount)&&typeof result.redactionDigest==='string',
      url:safe(result?.url),domRevision:result?.domRevision??null,geometryRevision:result?.geometryRevision??null,
      viewport:{width:result?.viewport?.width??null,height:result?.viewport?.height??null,dpr:result?.viewport?.devicePixelRatio??null},
      boxCount:result?.redactionCount??null,_documentToken:result?.documentToken||'',
      _redactionDigest:result?.redactionDigest||'',_visibleTextDigest:result?.visibleTextDigest||'',_controlDigest:result?.controlDigest||''
    });
    const compare=(first,next)=>({
      documentChanged:first._documentToken!==next._documentToken,
      domRevisionChanged:first.domRevision!==next.domRevision,
      geometryRevisionChanged:first.geometryRevision!==next.geometryRevision,
      urlChanged:first.url!==next.url,
      viewportChanged:JSON.stringify(first.viewport)!==JSON.stringify(next.viewport),
      redactionDigestChanged:first._redactionDigest!==next._redactionDigest,
      visibleTextChanged:first._visibleTextDigest!==next._visibleTextDigest,
      controlFingerprintChanged:first._controlDigest!==next._controlDigest,
      boxCountChanged:first.boxCount!==next.boxCount
    });
    try {
      const firstReply=await chrome.tabs.sendMessage(${tabId},{type:'VISUAL_STABILITY'});
      if(firstReply?.ok!==true)return {ok:false,reason:'local-stability-refused',visualStage:firstReply?.visualStage||'unknown'};
      const first=compact(firstReply);
      const samples=[];
      for(let index=0;index<${sampleCount};index++){
        await new Promise(resolve=>setTimeout(resolve,650));
        const next=compact(await chrome.tabs.sendMessage(${tabId},{type:'VISUAL_STABILITY'}));
        samples.push({index:index+1,valid:next.valid,domRevision:next.domRevision,geometryRevision:next.geometryRevision,
          boxCount:next.boxCount,differenceFromFirst:compare(first,next)});
      }
      return {ok:first.valid,first:{valid:first.valid,url:first.url,domRevision:first.domRevision,geometryRevision:first.geometryRevision,
        viewport:first.viewport,boxCount:first.boxCount},samples};
    } catch { return {ok:false,reason:'local-stability-refused',visualStage:'transport'}; }
  })()`, Math.max(20000, sampleCount * 2500 + 10000));
}

async function probeRollingCapture() {
  return evaluate(controller, `(async()=>{
    // Raw pixels are intentionally scoped to this closure and discarded before
    // returning. This probe reports only local counts and safety booleans.
    const observe=()=>chrome.tabs.sendMessage(${tabId},{type:'OBSERVE',captureRequested:true});
    const sameSurface=(a,b)=>{
      const x=a?.pageMetadata||{},y=b?.pageMetadata||{},av=a?.viewport||{},bv=b?.viewport||{};
      return !!x.documentToken&&x.documentToken===y.documentToken&&x.geometryRevision===y.geometryRevision&&
        a?.url===b?.url&&av.width===bv.width&&av.height===bv.height&&av.devicePixelRatio===bv.devicePixelRatio;
    };
    const covered=(union,later)=>(later||[]).every(next=>(union||[]).some(prior=>
      next.x>=prior.x&&next.y>=prior.y&&next.x+next.width<=prior.x+prior.width&&next.y+next.height<=prior.y+prior.height));
    const union=(groups)=>{
      const seen=new Set(),out=[];
      for(const group of groups)for(const box of group||[]){const key=[box.x,box.y,box.width,box.height,box.kind].join('|');if(!seen.has(key)){seen.add(key);out.push(box);}}
      return out;
    };
    try {
      let current=await observe(),groups=[current.redactionBoxes],collected=0;
      const samples=[];
      for(let i=0;i<3;i++){
        await new Promise(resolve=>setTimeout(resolve,250));
        const next=await observe();
        const usable=sameSurface(current,next);
        if(usable){groups.push(next.redactionBoxes);current=next;collected++;}
        samples.push({usable,boxCount:Array.isArray(next?.redactionBoxes)?next.redactionBoxes.length:null});
      }
      const masks=union(groups);
      const hidden=await chrome.tabs.sendMessage(${tabId},{type:'CAPTURE_PANEL',mode:'hide'});
      let captured=false;
      try {
        if(hidden?.ok!==true)return {ok:false,reason:'panel-hide-refused'};
        await chrome.tabs.update(${tabId},{active:true});
        const raw=await chrome.tabs.captureVisibleTab(${session.windowId},{format:'jpeg',quality:82});
        captured=typeof raw==='string'&&raw.startsWith('data:image/jpeg;base64,');
      } finally { await chrome.tabs.sendMessage(${tabId},{type:'CAPTURE_PANEL',mode:'restore'}).catch(()=>null); }
      const after=await observe();
      return {ok:true,captured,initialBoxCount:groups[0]?.length??null,samples,collected,unionBoxCount:masks.length,
        afterBoxCount:Array.isArray(after?.redactionBoxes)?after.redactionBoxes.length:null,
        sameSurfaceAfterCapture:sameSurface(current,after),afterMasksCoveredByUnion:covered(masks,after?.redactionBoxes)};
    } catch { return {ok:false,reason:'local-capture-probe-refused'}; }
  })()`, 30000);
}

const report = {
  testedAt: new Date().toISOString(),
  scope: 'public normal-tab lease stability probe; no screenshots, OCR, text, values or geometry leave the extension',
  sites: [],
};
for (const site of process.argv.includes('--amazon-only') ? sites.slice(0, 1) : sites) {
  const readiness = await waitForReady(site);
  const lease = readiness.ok && !process.argv.includes('--pacing') ? await sampleLease() : undefined;
  const pacing = readiness.ok && process.argv.includes('--pacing') ? await samplePacing() : undefined;
  const capture = readiness.ok && process.argv.includes('--capture') ? await probeRollingCapture() : undefined;
  const entry = { site: site.name, readiness, ...(lease ? { lease } : {}), ...(pacing ? { pacing } : {}), ...(capture ? { capture } : {}) };
  report.sites.push(entry);
  console.log(JSON.stringify(entry));
}
await mkdir(new URL('../runtime/', import.meta.url), { recursive: true });
await writeFile(new URL('../runtime/live-lease-diagnostic.json', import.meta.url), JSON.stringify(report, null, 2));
process.exitCode = report.sites.every(entry => (entry.capture || entry.pacing || entry.lease)?.ok) ? 0 : 1;
