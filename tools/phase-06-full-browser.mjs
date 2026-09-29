// Phase-06 whole-flow validation in an explicitly disposable Edge profile.
// Never run against a personal browser, remote web page or real account.
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { sanitizeObservation } from '../server/outbound-contract.mjs';

const root=fileURLToPath(new URL('..',import.meta.url));
const profile=join(root,'tests','fixtures','phase-06-full-profile');
const port=Number((await readFile(join(profile,'DevToolsActivePort'),'utf8')).split(/\r?\n/)[0]);
if(!Number.isInteger(port)||port<1024||port>65535) throw Error('No disposable Edge debug port.');
const url=`http://127.0.0.1:${port}`;
const targets=await (await fetch(url+'/json/list')).json();
const ext=targets.find(t=>t.type==='service_worker'&&/\/action-binding-entry\.js$/.test(t.url));
// This ID was read from the *current disposable profile* in its first live
// /json/list. MV3 workers legitimately sleep after idle.
const extId=ext?new URL(ext.url).host:'mdimbjeanhagcmpcdpdgjjjbeibflkob';
function attach(wsUrl){
  const ws=new WebSocket(wsUrl),pending=new Map(),events=[];let id=0;
  const ready=new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true})});
  ws.addEventListener('message',e=>{
    let data;try{data=JSON.parse(e.data)}catch{return}
    if(pending.has(data.id)){const p=pending.get(data.id);pending.delete(data.id);data.error?p.reject(Error(data.error.message)):p.resolve(data.result);}
    else{if(events.length<2000)events.push(data);}
  });
  const call=async(method,params={})=>{await ready;return new Promise((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject});ws.send(JSON.stringify({id:n,method,params}));})};
  async function evalJS(expression){const data=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,timeout:120000});
    if(data.exceptionDetails)throw Error(data.exceptionDetails.exception?.description||data.exceptionDetails.text);
    return data.result?.value;}
  return {ws,call,evalJS,events,ready};
}
let pageTarget=targets.find(t=>t.type==='page'&&t.url===`chrome-extension://${extId}/popup.html`)
  ||targets.find(t=>t.type==='page'&&/^(?:edge|chrome):\/\/extensions/.test(t.url))
  ||targets.find(t=>t.type==='page'&&t.url==='about:blank');
if(!pageTarget){
  // Extension reload closes its own controller pages; reopen exactly one
  // ordinary disposable control target in this SAME browser/profile.
  const browserInfo=await (await fetch(url+'/json/version')).json();
  const browser=attach(browserInfo.webSocketDebuggerUrl);
  await browser.call('Target.createTarget',{url:`chrome-extension://${extId}/popup.html`});
  browser.ws.close();
  await new Promise(r=>setTimeout(r,300));
  pageTarget=(await (await fetch(url+'/json/list')).json()).find(t=>t.type==='page'&&
    t.url===`chrome-extension://${extId}/popup.html`);
}
if(!pageTarget)throw Error('Disposable normal extension control page unavailable.');
const page=attach(pageTarget.webSocketDebuggerUrl);
await page.call('Page.enable');await page.call('Runtime.enable');
await page.call('Page.navigate',{url:`chrome://extensions/?id=${extId}`});
await new Promise(r=>setTimeout(r,900));
const access=await page.evalJS(`(()=>{
 let match=null;
 const walk=(node,depth=0)=>{
   if(depth>10||match)return;
   for(const el of node.querySelectorAll('*')){
     if(el.localName==='standard-row'&&el.textContent?.includes('Allow in InPrivate')&&el.querySelector('fluent-switch')){match=el.querySelector('fluent-switch');break;}
     if(el.shadowRoot)walk(el.shadowRoot,depth+1);
   }
 };
 walk(document);
 if(!match)return {found:false};
 const previous=match.getAttribute('checked');
 if(previous!=='true')match.click();
 return {found:true,previous,after:match.getAttribute('checked')};
})()`);
if(!access.found)throw Error('Disposable Edge InPrivate extension switch unavailable.');
await new Promise(r=>setTimeout(r,600));
await page.call('Page.navigate',{url:`chrome-extension://${extId}/popup.html`});
await new Promise(r=>setTimeout(r,400));
const permission=await page.evalJS(`chrome.extension.isAllowedIncognitoAccess()`);
if(permission!==true)throw Error('Cannot enable CAPTAIN InPrivate access in disposable profile.');
if(process.argv.includes('--reload')){
  try{await page.evalJS('chrome.runtime.reload()')}catch{}
  page.ws.close();
  console.log(JSON.stringify({phase:'disposable-extension-reload-requested',permission:true}));
  process.exit(0);
}
const windows=await page.evalJS(`chrome.windows.getAll({populate:true}).then(ws=>ws.map(w=>({
  id:w.id,incognito:w.incognito,tabs:w.tabs?.map(t=>({id:t.id,incognito:t.incognito,url:t.url}))
})))`);
console.log(JSON.stringify({phase:'actual-incognito-setup',extensionId:extId,permission,access,windows},null,2));
page.ws.close();
const current=await (await fetch(url+'/json/list')).json();
let incognitoWindow=null;
for(const target of current.filter(t=>t.type==='service_worker'&&t.url===`chrome-extension://${extId}/action-binding-entry.js`)){
 const background=attach(target.webSocketDebuggerUrl);await background.call('Runtime.enable');
 const evidence=await background.evalJS(`(async()=>({incognito:chrome.extension.inIncognitoContext,
   windows:await chrome.windows.getAll({populate:true}).then(ws=>ws.map(w=>({
     id:w.id,incognito:w.incognito,tabs:w.tabs?.map(t=>({id:t.id,incognito:t.incognito,url:t.url}))
   }))) }))()`);
 console.log(JSON.stringify({phase:'background-context',targetId:target.id,...evidence},null,2));
 if(evidence.incognito)incognitoWindow=evidence.windows.find(w=>w.incognito&&w.tabs.some(t=>t.url==='http://127.0.0.1:4317/privacy-fixture.html'))||null;
 background.ws.close();
}
if(!incognitoWindow)throw Error('Disposable incognito browser context unavailable.');
const fixtureTab=incognitoWindow.tabs.find(t=>t.url==='http://127.0.0.1:4317/privacy-fixture.html');
const fixtureTarget=current.find(t=>t.type==='page'&&t.url===fixtureTab.url);
if(!fixtureTarget)throw Error('Disposable fixture page target unavailable.');
const fixture=attach(fixtureTarget.webSocketDebuggerUrl);
await fixture.call('Page.enable');await fixture.call('Runtime.enable');
await fixture.call('Page.reload',{ignoreCache:true});
await new Promise(r=>setTimeout(r,700));
const panel=await fixture.evalJS(`(()=>{const host=document.querySelector('#captain-agent-host');
 return {mounted:!!host, build:host?.dataset.captainBuild,
   hasMic:!!host?.shadowRoot?.querySelector('.mic'),
   publicTitle:document.title}})()`);
if(!panel.mounted||!panel.hasMic)throw Error('Real Incognito content-script panel not mounted.');
const open=await fixture.evalJS(`(()=>{document.querySelector('#captain-agent-host').shadowRoot.querySelector('.mic').click();return true})()`);
await new Promise(r=>setTimeout(r,700));
const after=await (await fetch(url+'/json/list')).json();
const controller=after.find(t=>t.type==='page'&&t.url===`chrome-extension://${extId}/popup.html?window=${incognitoWindow.id}`);
console.log(JSON.stringify({phase:'real-page-panel-to-incognito-popup',incognitoWindowId:incognitoWindow.id,
  fixtureTabId:fixtureTab.id,panel,clicked:open,popupOpened:!!controller},null,2));
fixture.ws.close();
if(!controller)throw Error('CAPTAIN content-script mic did not open the actual Incognito controller.');
const controllerCDP=attach(controller.webSocketDebuggerUrl);
await controllerCDP.call('Runtime.enable');
await new Promise(r=>setTimeout(r,250));
const controllerReady=await controllerCDP.evalJS(`(()=>{
 
 return {extensionOrigin:location.origin,windowBound:new URL(location.href).searchParams.get('window'),
   composer:!!document.querySelector('#composer'),run:!!document.querySelector('#run'),
   connected:!!window.chrome?.runtime?.id}
})()`);
if(!controllerReady.connected||!controllerReady.run||
   controllerReady.windowBound!==String(incognitoWindow.id))throw Error('Actual incognito controller not ready.');
const workers=await (await fetch(url+'/json/list')).json();
let bg=null;
for(const target of workers.filter(t=>t.type==='service_worker'&&t.url===`chrome-extension://${extId}/action-binding-entry.js`)){
 const probe=attach(target.webSocketDebuggerUrl);await probe.call('Runtime.enable');
 const isIncognito=await probe.evalJS('chrome.extension.inIncognitoContext');
 if(isIncognito){bg=probe;break;}
 probe.ws.close();
}
if(!bg)throw Error('Real split-mode Incognito service worker unavailable.');
await bg.call('Network.enable',{maxPostDataSize:4500000});
const actualBinding=await bg.evalJS(`(async()=>({
 incognito:chrome.extension.inIncognitoContext,
 tab:(await chrome.tabs.get(${fixtureTab.id})).incognito,
 binding:(await chrome.storage.session.get('captainWindow:${incognitoWindow.id}'))['captainWindow:${incognitoWindow.id}'],
 setting:(await chrome.storage.sync.get({serverUrl:'http://127.0.0.1:4317',includeScreenshot:true,maxSteps:12}))
}))()`);
if(!actualBinding.incognito||!actualBinding.tab||
 actualBinding.binding?.tabId!==fixtureTab.id)throw Error('Real local controller target binding was not created.');
await bg.evalJS(`chrome.storage.sync.set({serverUrl:'http://127.0.0.1:4317',includeScreenshot:true,maxSteps:3})`);
console.log(JSON.stringify({phase:'real-controller-binding-and-planner-monitor',
  controllerReady,incognito:true,boundTabCorrect:true,networkMonitorEnabled:true},null,2));
const observationDiagnostic=await bg.evalJS(`(async()=>{
 const observed=await chrome.tabs.sendMessage(${fixtureTab.id},{type:'OBSERVE',captureRequested:true});
 const flags=[];function walk(value,path='',depth=0){
  if(depth>8||flags.length>60)return;
  if(typeof value==='string'){const hit=CAPTAIN_PRIVACY.scanSpans(value);
   if(hit.some(x=>x.type==='UNKNOWN'))flags.push({path,length:value.length,types:[...new Set(hit.map(x=>x.type))]});}
  else if(Array.isArray(value))value.forEach((v,i)=>walk(v,path+'['+i+']',depth+1));
  else if(value&&typeof value==='object')Object.entries(value).forEach(([k,v])=>walk(v,path+'.'+k,depth+1));
 }
 walk(observed);
 return {error:observed.error||null,keys:Object.keys(observed),unknownPaths:flags,
  elementCount:observed.elements?.length,redactionCount:observed.redactionBoxes?.length,
  metadataFields:Object.keys(observed.pageMetadata||{})};
})()`);
console.log(JSON.stringify({phase:'local-observation-diagnostic',...observationDiagnostic},null,2));

async function runTask(command,timeoutMs=115000,expect='success'){
 const prior=bg.events.length;
 const begin=performance.now();
 // Do not mistake a previous stopped task's generic privacy error for the
 // terminal state of this fresh isolated command.
 await bg.evalJS("chrome.storage.local.set({captainState:{status:'idle'}})");
 // A popup retains its in-memory pendingRequestId after a prior task. Refresh
 // the *disposable* controller between experiments rather than treating a
 // no-op click on the Busy UI as a successful START_TASK.
 await controllerCDP.call('Page.reload',{ignoreCache:true});
 await new Promise(r=>setTimeout(r,350));
 await controllerCDP.evalJS('true');
 const dispatched=await controllerCDP.evalJS(`(()=>{
   const toggle=document.querySelector('#type-toggle');
   if(document.querySelector('#composer')?.hidden)toggle.click();
   const editor=document.querySelector('#task');
   if(!editor||document.querySelector('#composer')?.hidden)return false;
   editor.value=${JSON.stringify(command)};document.querySelector('#run').click();return true
 })()`);
 if(!dispatched)throw Error('Actual typed composer did not dispatch the command.');
 let state,done=false;
 for(let n=0;n<Math.ceil(timeoutMs/1000);n++){
   await new Promise(r=>setTimeout(r,1000));
   state=await bg.evalJS(`chrome.storage.local.get('captainState').then(s=>s.captainState||{})`);
   if(['complete','error'].includes(state?.status)&&
     (state.task===command||state.message==='Privacy protection withheld local task status.')){done=true;break;}
 }
 const captures=bg.events.slice(prior).filter(e=>e.method==='Network.requestWillBeSent'&&
    e.params?.request?.url?.endsWith('/api/agent/step')).map(e=>e.params);
 const payloads=[];
 for(const item of captures){
   let raw=item.request?.postData;
   if(!raw){try{raw=(await bg.call('Network.getRequestPostData',{requestId:item.requestId})).postData;}catch{}}
   if(raw){try{payloads.push(JSON.parse(raw));}catch{}}
 }
 const networkResponses=[];
 for(const item of captures){
   const responseEvent=bg.events.find(e=>e.method==='Network.responseReceived'&&
     e.params?.requestId===item.requestId);
   let plan=null;
   if(responseEvent){
     try{
       const body=(await bg.call('Network.getResponseBody',{requestId:item.requestId}));
       plan=JSON.parse(body.base64Encoded?Buffer.from(body.body,'base64').toString('utf8'):body.body);
     }catch{}
   }
   let planDiagnostics=null;
   if(plan){
     const value=JSON.stringify(plan);
     planDiagnostics=await bg.evalJS(`(()=>{
       const plan=${value};
       const bad=[];function walk(v,p=''){
        if(typeof v==='string'){const spans=CAPTAIN_PRIVACY.scanSpans(v);
          if(spans.length)bad.push({path:p,types:[...new Set(spans.map(s=>s.type))]});}
        else if(Array.isArray(v))v.forEach((x,i)=>walk(x,p+'['+i+']'));
        else if(v&&typeof v==='object')Object.entries(v).forEach(([k,x])=>walk(x,p+'.'+k));
       }walk(plan);
       let assert='not-accessible',sanitize='not-accessible';
       if(typeof assertNoPrivatePlannerText==='function'){
         try{assertNoPrivatePlannerText(plan);assert='passed';}catch{assert='blocked';}
       }
       if(typeof sanitizePayload==='function'){
         try{sanitizePayload(plan);sanitize='passed';}catch{sanitize='blocked';}
       }
       return {bad,assert,sanitize};
     })()`);
   }
   networkResponses.push({status:responseEvent?.params?.response?.status??null,
     planType:plan?.action?.type||null,planKeys:plan?Object.keys(plan).sort():null,
     planMessageLength:plan?.action?.message?.length??null,planDiagnostics});
 }
 const forbidden=/luv\.tankha\.sih@example\.com|9876543210|ABCDE1234F|NeverTransmitThis|221B Test Road|1234[\s-]?5678[\s-]?9012[\s-]?3456/i;
 const outbound=payloads.map(input=>({
   taskSafe:input.task===command,rootKeys:Object.keys(input).sort(),
   contract:(()=>{try{sanitizeObservation(input);return 'accepted';}catch(error){return error.message;}})(),
   historyStructure:(input.history||[]).map(item=>({
     keys:Object.keys(item).sort(),actionKeys:Object.keys(item.action||{}).sort(),
     resultKeys:Object.keys(item.result||{}).sort()
   })),
   privateTextLeaked:forbidden.test(JSON.stringify(input)),
   hasScreenshot:typeof input.context?.screenshot==='string',
   hasVisualPrivacy:input.context?.visualPrivacy?.schema==='captain.visual-privacy.v2',
   hasLocalIdentity:Object.hasOwn(input.context?.pageMetadata||{},'documentToken')||
     Object.hasOwn(input.context?.pageMetadata||{},'observationId'),
   hasModelOnlyCoordinates:['redactionBoxes','uiSnapshot','detections','matchedRefs'].some(
     key=>Object.hasOwn(input.context||{},key))||/"(?:matchedRefs|detections|uiSnapshot)":/.test(JSON.stringify(input)),
   rawScreenshotTransmitted:input.context?.visualPrivacy?.rawScreenshotTransmitted,
   coverageVerified:input.context?.visualPrivacy?.coverageVerified,
   maskCount:input.context?.visualPrivacy?.pixelMaskCount,
   sha256:input.context?.visualPrivacy?.imageSha256,
   screenshotBytes:input.context?.visualPrivacy?.outputBytes,
   jpegDigestOK:(()=>{
     const data=input.context?.screenshot,proof=input.context?.visualPrivacy;
     if(typeof data!=='string'||!data.startsWith('data:image/jpeg;base64,'))return false;
     const bytes=Buffer.from(data.split(',')[1],'base64');
     return bytes.length===proof?.outputBytes&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255&&
       bytes.at(-2)===255&&bytes.at(-1)===217&&
       createHash('sha256').update(bytes).digest('hex')===proof?.imageSha256;
   })(),
   captureTiming:input.context?.localTiming,
 }));
 const maskPixels=[];
 for(const input of payloads){
   const jpeg=input.context?.screenshot;
   if(typeof jpeg!=='string'||!jpeg.startsWith('data:image/jpeg;base64,')){maskPixels.push(null);continue;}
   const sample=await controllerCDP.evalJS(`(async()=>{
      const blob=await(await fetch(${JSON.stringify(jpeg)})).blob();
      const bitmap=await createImageBitmap(blob);
      const canvas=document.createElement('canvas');canvas.width=bitmap.width;canvas.height=bitmap.height;
      const ctx=canvas.getContext('2d',{willReadFrequently:true});ctx.drawImage(bitmap,0,0);bitmap.close();
      const values=ctx.getImageData(0,0,canvas.width,canvas.height).data;
      let opaque=true;let sampled=0;let nonOpaquePixelCount=0;
      for(let i=0;i<values.length;i+=4){
        if(values[i]>32||values[i+1]>32||values[i+2]>32)nonOpaquePixelCount++;
      }
      for(let y=0;y<5;y++)for(let x=0;x<5;x++){
        const ix=Math.floor((x+.5)*canvas.width/5),iy=Math.floor((y+.5)*canvas.height/5);
        const at=(iy*canvas.width+ix)*4;sampled++;
        if(values[at]>32||values[at+1]>32||values[at+2]>32)opaque=false;
      }
      return {sampled,opaque,nonOpaquePixelCount,width:canvas.width,height:canvas.height};
    })()`);
   maskPixels.push(sample);
 }
 const currentState={status:state?.status,phase:state?.phase,completionStatus:state?.completionStatus,
   outcomeVerified:state?.outcomeVerified,step:state?.step,piiDetected:state?.piiDetected,
   historyLength:state?.history?.length,timelineTypes:(state?.timeline||[]).map(e=>e.type),
   messagePrivateTextLeaked:forbidden.test(JSON.stringify(state||{})),
   publicMessage:state?.message?.slice(0,150)};
 const report={command,dispatched,terminal:done,elapsedMs:Math.round(performance.now()-begin),
   outgoingRequests:captures.length,capturedPayloads:payloads.length,outbound,
   networkResponses,maskPixels,state:currentState};
 if(expect==='capture-fail'){
   if(!done||state?.status!=='error'||captures.length!==0||payloads.length!==0||
      currentState.messagePrivateTextLeaked||!/(?:visual privacy failed|observation failed|page information withheld)/i.test(state?.message||'')){
     console.log(JSON.stringify({phase:'full-flow-fail-closed-test-failure',...report},null,2));
     throw Error('Mutation race did not fail closed before local planner egress.');
   }
   return {report,payloads};
 }
 if(!done||state?.status!=='complete'||payloads.length!==captures.length||captures.length<1||
     networkResponses.some(x=>x.status!==200)||
     outbound.some(x=>x.privateTextLeaked||x.hasLocalIdentity||x.hasModelOnlyCoordinates||
     !x.taskSafe||!x.hasScreenshot||!x.hasVisualPrivacy||x.rawScreenshotTransmitted!==false||
     x.coverageVerified!==true||x.maskCount<1||!x.jpegDigestOK||x.contract!=='accepted')||
     maskPixels.some(x=>x?.opaque!==true||x.sampled!==25||x.nonOpaquePixelCount!==0)||currentState.messagePrivateTextLeaked){
   console.log(JSON.stringify({phase:'full-flow-task-failure',...report},null,2));
   throw Error('Full browser egress/task validation failed.');
 }
 return {report,payloads};
}
const first=await runTask('Inspect this synthetic page');
console.log(JSON.stringify({phase:'full-flow-normal',...first.report},null,2));
const second=await runTask('Scroll down');
console.log(JSON.stringify({phase:'full-flow-grounded-action',...second.report},null,2));
// Mutate the same offline page during capture and local inference to ensure
// stale DOM/geometry observations are never accepted for outgoing imagery.
const raceTarget=(await (await fetch(url+'/json/list')).json()).find(t=>t.type==='page'&&
  t.url==='http://127.0.0.1:4317/privacy-fixture.html');
if(!raceTarget)throw Error('Synthetic race fixture target missing.');
const race=attach(raceTarget.webSocketDebuggerUrl);await race.call('Runtime.enable');
await race.evalJS(`(()=>{
  let n=document.querySelector('#captain-disposable-race');
  if(!n){n=document.createElement('span');n.id='captain-disposable-race';document.body.append(n)}
  window.captainDisposableRace=window.setInterval(()=>{n.textContent='safe synthetic update '+Date.now()},20);
  return true;
})()`);
let raced;
try{raced=await runTask('Inspect this synthetic page',30000,'capture-fail');}
finally{await race.evalJS(`clearInterval(window.captainDisposableRace);document.querySelector('#captain-disposable-race')?.remove();true`);race.ws.close();}
console.log(JSON.stringify({phase:'full-flow-stale-page-fail-closed',...raced.report},null,2));
const staleActions=await bg.evalJS(`(async()=>{
  const o=await chrome.tabs.sendMessage(${fixtureTab.id},{type:'OBSERVE'});
  const control=o.elements?.find(e=>/^c[1-9]\\d*$/.test(e.ref));
  if(!control)return {controlFound:false};
  const action={type:'type',target:{ref:control.ref},value:'synthetic-do-not-write'};
  const absent=await chrome.tabs.sendMessage(${fixtureTab.id},{type:'EXECUTE',action});
  const stale={documentToken:o.pageMetadata.documentToken,
    observationId:o.pageMetadata.observationId,domRevision:o.pageMetadata.domRevision,
    geometryRevision:o.pageMetadata.geometryRevision+1};
  const changed=await chrome.tabs.sendMessage(${fixtureTab.id},
    {type:'EXECUTE',action,observationGuard:stale});
  return {controlFound:true,unguardedBlocked:absent.ok===false,
    staleBlocked:changed.ok===false,
    genericGuardError:/Observation expired or target changed; action blocked/.test(absent.error||'')&&
      /Observation expired or target changed; action blocked/.test(changed.error||'')};
})()`);
if(!staleActions.controlFound||!staleActions.unguardedBlocked||!staleActions.staleBlocked||!staleActions.genericGuardError)
  throw Error('Live unguarded or stale DOM action was not rejected.');
console.log(JSON.stringify({phase:'real-content-script-action-guards',...staleActions},null,2));
// A real ordinary-profile controller must never be allowed to use this
// Incognito-only task path. The regular and InPrivate extension workers are
// isolated; monitor the regular worker for planner egress as well.
const normalTargets=await (await fetch(url+'/json/list')).json();
const normalTarget=normalTargets.find(t=>t.type==='page'&&t.url===`chrome-extension://${extId}/popup.html`);
if(!normalTarget)throw Error('Disposable regular-profile controller missing.');
const normal=attach(normalTarget.webSocketDebuggerUrl);await normal.call('Runtime.enable');
await normal.call('Network.enable',{maxPostDataSize:4500000});
const normalPrior=normal.events.length;
const normalDispatch=await normal.evalJS(`chrome.runtime.sendMessage({type:'START_TASK',task:'Inspect this synthetic page'})`);
let normalState=null;
for(let n=0;n<15;n++){
  await new Promise(r=>setTimeout(r,200));
  normalState=await normal.evalJS(`chrome.storage.local.get('captainState').then(s=>s.captainState||{})`);
  if(normalState.status==='error')break;
}
const normalRequests=normal.events.slice(normalPrior).filter(e=>e.method==='Network.requestWillBeSent'&&
  e.params?.request?.url?.endsWith('/api/agent/step')).length;
const ordinary={dispatched:normalDispatch?.ok===true,status:normalState?.status,
  blockedForIncognito:/(?:Incognito|InPrivate)/i.test(normalState?.message||''),plannerRequests:normalRequests};
if(!ordinary.dispatched||ordinary.status!=='error'||!ordinary.blockedForIncognito||ordinary.plannerRequests!==0)
  throw Error('Regular profile was not rejected before planner egress.');
console.log(JSON.stringify({phase:'full-flow-ordinary-profile-denied',...ordinary},null,2));
normal.ws.close();
const compact=([kind,run])=>({kind,completed:run.report.terminal,
  status:run.report.state.status,completionStatus:run.report.state.completionStatus||null,
  steps:run.report.state.step||0,elapsedMs:run.report.elapsedMs,
  piiCount:run.report.state.piiDetected||0,
  plannerRequests:run.report.outgoingRequests,
  plannerStatuses:run.report.networkResponses.map(r=>r.status),
  plannerActions:run.report.networkResponses.map(r=>r.planType),
  outbound:run.report.outbound.map(o=>({contract:o.contract,privateTextLeaked:o.privateTextLeaked,
    hasLocalIdentity:o.hasLocalIdentity,hasModelOnlyCoordinates:o.hasModelOnlyCoordinates,
    hasVerifiedV2:o.hasVisualPrivacy&&o.coverageVerified&&o.rawScreenshotTransmitted===false,
    jpegDigestOK:o.jpegDigestOK,maskCount:o.maskCount,outputBytes:o.screenshotBytes,
    captureMs:o.captureTiming?.captureMs,localVisionAndRedactionMs:o.captureTiming?.localVisionAndRedactionMs})),
  imageCoverage:run.report.maskPixels.map(p=>({width:p.width,height:p.height,
    examinedPixels:p.width*p.height,nonOpaquePixelCount:p.nonOpaquePixelCount})),
  taskTimelineTypes:run.report.state.timelineTypes});
const evidence={scope:'Real unpacked Edge InPrivate panel-popup-MV3 service worker, local synthetic fixture, local real companion; not release acceptance',
  extensionId:extId,host:'127.0.0.1',modelConfidenceThreshold:0.75,
  realSplitIncognitoController:true,
  outcomes:[compact(['one-step',first]),compact(['two-step-scroll',second]),
    compact(['stale-document-negative',raced])],
  ordinaryProfileDenied:ordinary,
  realContentScriptActionGuards:staleActions,
  caveats:['Synthetic localhost only','Image pixel readback is decoded JPEG; real-world PII recall unmeasured',
    'Power, real browser memory, full site coverage and live Firefox unmeasured',
    'No real account, external planner, real-world consequential action or Phase 07 used']};
await writeFile(new URL('../benchmarks/phase-06-full-browser.json',import.meta.url),JSON.stringify(evidence,null,2)+'\n');
console.log(JSON.stringify({phase:'full-browser-metadata-evidence-saved',
  outcomes:evidence.outcomes.map(r=>({kind:r.kind,status:r.status,plannerRequests:r.plannerRequests})),
  ordinaryProfileDenied:ordinary.blockedForIncognito},null,2));
bg.ws.close();controllerCDP.ws.close();
