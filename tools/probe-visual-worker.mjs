// Safe normal-browser visual-worker probe. It navigates only to CAPTAIN's
// localhost privacy fixture and returns only fixed metadata/counts: never a
// screenshot, OCR text, page text, field values, masks or model output.
import assert from 'node:assert/strict';
import { cdp, debugJson, evaluate, extensionPath, findNormalWorker, findSession } from './reload-in-place.mjs';

const version = await debugJson('/json/version');
const installed = await cdp(version.webSocketDebuggerUrl, 'Extensions.getExtensions');
const extension = installed.extensions.find(item => item.path?.toLowerCase() === extensionPath.toLowerCase());
assert.ok(extension?.id, 'Run npm run demo first.');
const session = await findSession(extension.id);
assert.ok(session?.controller && Number.isSafeInteger(session.windowId), 'Normal CAPTAIN controller unavailable.');
const privateWorker = await findNormalWorker(extension.id, session.windowId);
assert.ok(privateWorker?.worker, 'Normal CAPTAIN service worker unavailable.');

const report = await evaluate(privateWorker.worker, `(async()=>{
  const targetUrl='http://127.0.0.1:4317/privacy-fixture.html';
  let tab=(await chrome.tabs.query({windowId:${session.windowId}})).find(item=>item.url===targetUrl&&!item.incognito);
  if(!tab)tab=await chrome.tabs.create({windowId:${session.windowId},url:targetUrl,active:true});
  else await chrome.tabs.update(tab.id,{active:true,url:targetUrl});
  const deadline=Date.now()+20000;
  do{await new Promise(resolve=>setTimeout(resolve,150));tab=await chrome.tabs.get(tab.id)}while((tab.status!=='complete'||tab.pendingUrl)&&Date.now()<deadline);
  if(tab.status!=='complete'||tab.pendingUrl)return {ok:false,reason:'fixture-not-ready'};
  const context=await chrome.tabs.sendMessage(tab.id,{type:'OBSERVE',captureRequested:true});
  const meta=context?.pageMetadata||{};
  if(!context||context.error||!meta.documentToken||!meta.observationId||!Array.isArray(context.redactionBoxes))
    return {ok:false,reason:'observation-unavailable'};
  let raw,lastCaptureError;
  for(let attempt=0;attempt<3&&!raw;attempt++){
    try{raw=await chrome.tabs.captureVisibleTab(tab.windowId,{format:'jpeg',quality:82})}
    catch(error){lastCaptureError=error;await new Promise(resolve=>setTimeout(resolve,300*(attempt+1)))}
  }
  if(!raw&&chrome.debugger?.attach){
    const debuggee={tabId:tab.id};
    try{await chrome.debugger.attach(debuggee,'1.3');const shot=await chrome.debugger.sendCommand(debuggee,'Page.captureScreenshot',{format:'jpeg',quality:82,fromSurface:true});raw=shot?.data?'data:image/jpeg;base64,'+shot.data:''}
    catch(error){lastCaptureError=error}finally{try{await chrome.debugger.detach(debuggee)}catch{}}
  }
  if(!raw)return {ok:false,reason:'capture-unavailable'};
  const hostUrl=chrome.runtime.getURL('offscreen.html');
  const hosts=await chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT'],documentUrls:[hostUrl],incognito:false});
  if(!hosts.length)await chrome.offscreen.createDocument({url:'offscreen.html',reasons:['WORKERS','BLOBS'],justification:'Run local CAPTAIN privacy self-check'});
  const lease={documentToken:meta.documentToken,observationId:meta.observationId,domRevision:meta.domRevision,geometryRevision:meta.geometryRevision};
  const uiSnapshot={lease,controls:(context.elements||[]).slice(0,250).map(element=>({ref:element.ref,box:element.bbox,source:element.source,visible:element.visible,enabled:element.enabled,sensitive:element.sensitive,lease}))};
  const result=await chrome.runtime.sendMessage({type:'VISION_REDACT',visionHost:'offscreen',windowId:tab.windowId,screenshot:raw,viewport:context.viewport,redactionBoxes:context.redactionBoxes,uiSnapshot,auditGateOnly:true});
  return {ok:result?.ok===true,reason:result?.ok===true?'ok':'visual-worker-denied',
    error:result?.ok===false?'Local visual privacy failed.':null,
    stage:typeof result?.stage==='string'?result.stage:null,
    detectedCategories:Object.keys(context.piiCounts||{}).length,
    redactionCount:context.redactionBoxes.length,
    ...(result?.ok===true?{auditGate:result.localAuditGate||null,ocrAudit:result.localOcrAudit||null,
      ocrMasks:result.localOcrRegionCount??null,alternativeMasks:result.localAlternativeRegionCount??null,
      uiMasks:result.localUiRegionCount??null,
      maskCount:result.visualPrivacy?.pixelMaskCount??null,fullBlackout:result.visualPrivacy?.fullBlackout===true,
      coverageVerified:result.visualPrivacy?.coverageVerified===true}:{})};
})()`);

const targets = await debugJson('/json/list');
const host = targets.find(item => item.type === 'background_page' && item.url === `chrome-extension://${extension.id}/offscreen.html`);
let hostState = null;
if (host?.webSocketDebuggerUrl) {
  hostState = await evaluate(host, `({workerActive:typeof visionWorker!=='undefined'&&!!visionWorker,
    pending:typeof visionPending==='object'?visionPending.size:null})`).catch(() => null);
}
console.log(JSON.stringify({ scope: 'normal-localhost-fixture-metadata-only', report, hostState }, null, 2));
process.exitCode = report.ok ? 0 : 1;
