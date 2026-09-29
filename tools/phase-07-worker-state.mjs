// Read-only metadata from the exact disposable CAPTAIN private controller.
// The probe never retrieves screenshot pixels, OCR, page text or credentials.
import assert from 'node:assert/strict';
import { cdp, debugJson, evaluate, extensionPath, findSession, findIncognitoWorker } from './reload-in-place.mjs';

const browser = await debugJson('/json/version');
const { extensions = [] } = await cdp(browser.webSocketDebuggerUrl, 'Extensions.getExtensions');
const installed = extensions.find(item => item.path?.toLowerCase() === extensionPath.toLowerCase());
assert.ok(installed?.id, 'Exact workspace extension not found.');
const session = await findSession(installed.id);
assert.ok(session?.controller && session.windowId, 'Private CAPTAIN controller unavailable.');
if (process.argv.includes('--focus-controller')) await evaluate(session.controller, `(async()=>{
  const self=await chrome.tabs.getCurrent();
  if(!self.incognito||self.windowId!==${session.windowId}||
     self.url?.split('?')[0]!==chrome.runtime.getURL('popup.html'))throw Error('Controller identity changed');
  await chrome.tabs.update(self.id,{active:true});return true;
})()`);
const observed = await evaluate(session.controller, `(async()=>{
  const self=await chrome.tabs.getCurrent();
  if (!self?.incognito || self.windowId!==${session.windowId} ||
      chrome.runtime.id!==${JSON.stringify(installed.id)}) throw Error('Controller identity changed');
  const s=await chrome.runtime.sendMessage({type:'GET_STATE'});
  const [active]=await chrome.tabs.query({windowId:self.windowId,active:true});
  return {private:true, status:['idle','running','complete','error','waiting_human'].includes(s.status)?s.status:'other',
    phase:['OBSERVING','PROTECTING_PRIVACY','EXECUTING','VERIFYING','RECOVERING','Complete','Stopped','Cancelled'].includes(s.phase)?s.phase:'other',
    boundController:Number.isSafeInteger(windowId)&&windowId===self.windowId,controllerActive:active?.id===self.id,
    routed:globalThis.__captainVisionRouteSeen||0,accepted:globalThis.__captainVisionRouteAccepted||0,
    pending:typeof visionPending==='object'&&visionPending instanceof Map?visionPending.size:null,
    workerAlive:typeof visionWorker!=='undefined'?!!visionWorker:null,
    sequence:typeof visionSequence==='number'?visionSequence:null};
})()`);
const privateWorker = await findIncognitoWorker(installed.id, session.windowId);
let failureStage = null;
if (privateWorker?.worker) {
  failureStage = await evaluate(privateWorker.worker,
    "['preflight','capture','capture-lease','worker-redact','worker-send','worker-await','worker-proof','redaction-lease'].includes(globalThis.__captainVisualFailureStage)?globalThis.__captainVisualFailureStage:null");
}
const captureState=privateWorker?.worker?await evaluate(privateWorker.worker,
  `({preferDebugger:typeof preferDebuggerCapture==='boolean'?preferDebuggerCapture:null,
    inputSize:Number.isSafeInteger(globalThis.__captainVisualInputSize)?globalThis.__captainVisualInputSize:null})`):null;
let workerStages=[];
if(process.argv.includes('--stages')) {
  for (const target of (await debugJson('/json/list')).filter(t=>t.type==='worker'&&t.webSocketDebuggerUrl).slice(0,5)) {
    try {workerStages.push(await evaluate(target,
      "['validate-input','decode-image','face-model-load','face-inference','local-ocr','ui-perception','pixel-redaction','jpeg-encode','jpeg-expanded-masks','jpeg-blackout-fallback','jpeg-decode','jpeg-verify','jpeg-digest','verified-complete'].includes(globalThis.__captainVisionStage)?globalThis.__captainVisionStage:'not-vision'",1200));}
    catch {workerStages.push('unresponsive');}
  }
}
let routeProbe = null;
if (process.argv.includes('--route') && privateWorker?.worker) {
  // Invalid synthetic input: no image data to leak; only a generic denial is
  // expected. This isolates extension message delivery from expensive OCR.
  const syntheticInput = process.argv.includes('--large-route')
    ? 'data:image/jpeg;base64,' + 'AAAA'.repeat(55000) : 'not-an-image';
  routeProbe = await evaluate(privateWorker.worker, `(async()=>{
    try {const r=await chrome.runtime.sendMessage({type:'VISION_REDACT',windowId:${session.windowId},
      screenshot:${JSON.stringify(syntheticInput)},viewport:{width:1,height:1,devicePixelRatio:1},redactionBoxes:[]});
      return {responded:!!r,denied:r?.ok===false};}
    catch{return {responded:false,denied:false};}
  })()`,12000);
}
console.log(JSON.stringify({ ...observed, failureStage, captureState, workerStages, routeProbe }));
