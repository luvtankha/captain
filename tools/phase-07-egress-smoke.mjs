// Original master-plan Phase 7: observe actual outbound HTTP requests from
// CAPTAIN's split Incognito service worker during a synthetic guarded click.
// The CDP connection and request bodies live in this process only; never log,
// persist, upload or expose screenshots, OCR, auth headers, canary values or
// request/response payloads. Report fixed aggregate booleans/counts only.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { debugJson, cdp, evaluate, extensionPath, findSession } from './reload-in-place.mjs';
import { assertSafeToTransmit, sanitizeObservation } from '../server/outbound-contract.mjs';
import { sanitizeMetricSample } from '../server/metrics.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const fixtureUrls = new Set([
  'http://127.0.0.1:4317/demo.html',
  'http://127.0.0.1:4317/demo.html?q=laptop',
  'http://127.0.0.1:4317/privacy-fixture.html',
  'http://127.0.0.1:4317/benchmark.html?case=login-form',
]);
const browser = await debugJson('/json/version');
const { extensions = [] } = await cdp(browser.webSocketDebuggerUrl, 'Extensions.getExtensions');
const installed = extensions.find(item => item.path?.toLowerCase() === extensionPath.toLowerCase());
assert.ok(installed?.id, 'Exact CAPTAIN workspace extension is required.');
const session = await findSession(installed.id);
assert.ok(session?.controller && session.windowId, 'Dedicated private CAPTAIN controller is required.');
const preflight = await evaluate(session.controller, `(async()=>{
  const owner=await chrome.tabs.getCurrent();
  return {incognito:owner.incognito,windowId:owner.windowId,
    tabs:(await chrome.tabs.query({windowId:owner.windowId})).map(t=>({incognito:t.incognito,url:t.url}))};
})()`);
assert.equal(preflight.incognito, true);
assert.equal(preflight.windowId, session.windowId);
assert.ok(preflight.tabs.every(tab=>tab.incognito && (
  fixtureUrls.has(tab.url) || tab.url?.startsWith(`chrome-extension://${installed.id}/`))),
  'Unreviewed tab exists; egress smoke refused to run.');

const workers = (await debugJson('/json/list')).filter(item => item.type === 'service_worker' &&
  item.url === `chrome-extension://${installed.id}/action-binding-entry.js`);
let worker;
for (const candidate of workers) {
  try { if (await evaluate(candidate, 'chrome.extension.inIncognitoContext') === true) { worker = candidate; break; } }
  catch { /* An inactive worker is not an acceptable egress monitor. */ }
}
assert.ok(worker?.webSocketDebuggerUrl, 'The exact Incognito worker could not be monitored.');

const requests = [], requestsById = new Map(), responsesById = new Map();
let nextId = 0;
const pending = new Map();
const socket = new WebSocket(worker.webSocketDebuggerUrl);
const connected = new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>reject(new Error('Private network monitor timed out.')),5000);
  socket.addEventListener('open',()=>{clearTimeout(timer);resolve();},{once:true});
  socket.addEventListener('error',()=>{clearTimeout(timer);reject(new Error('Private network monitor unavailable.'));},{once:true});
});
socket.addEventListener('message',event=>{
  let message;try{message=JSON.parse(event.data);}catch{return;}
  if(message.id && pending.has(message.id)){
    const item=pending.get(message.id);pending.delete(message.id);
    clearTimeout(item.timer);
    message.error?item.reject(new Error('Private network monitor request failed.')):item.resolve(message.result);
    return;
  }
  if(message.method==='Network.requestWillBeSent' && requests.length < 100){
    const request=message.params?.request;
    if(!request?.url) return;
    const entry={url:request.url,method:request.method,id:message.params.requestId,
      body:typeof request.postData==='string'?request.postData:null,
      hasPostData:request.hasPostData===true};
    requests.push(entry);
    requestsById.set(entry.id,entry);
  }
  if(message.method==='Network.responseReceived' && message.params?.requestId){
    responsesById.set(message.params.requestId,message.params.response?.status??null);
  }
});
async function call(method,params={},timeout=5000){
  await connected;
  return new Promise((resolve,reject)=>{
    const id=++nextId;
    const timer=setTimeout(()=>{pending.delete(id);reject(new Error('Private network monitor request timed out.'));},timeout);
    pending.set(id,{resolve,reject,timer});
    socket.send(JSON.stringify({id,method,params}));
  });
}
let child;
try {
  await call('Network.enable',{maxPostDataSize:4500000});
  // Existing guarded fixture smoke carries no real browser/site credentials.
  const completed=await new Promise((resolve,reject)=>{
    child=spawn(process.execPath,['tools/phase-07-task-smoke.mjs','--click-privacy'],{
      cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']
    });
    let stdout='',stderr='';
    child.stdout.on('data',chunk=>{stdout+=chunk.toString('utf8');if(stdout.length>25000)stdout=stdout.slice(-25000);});
    child.stderr.on('data',chunk=>{stderr+=chunk.toString('utf8');if(stderr.length>25000)stderr=stderr.slice(-25000);});
    child.once('error',()=>reject(new Error('Synthetic action runner could not start.')));
    child.once('exit',code=>resolve({code,stdout,stderr}));
  });
  assert.equal(completed.code,0,'The guarded synthetic task did not pass.');
  const task=JSON.parse(completed.stdout);
  assert.equal(task.privateWindow,true);
  assert.equal(task.syntheticClickVerified,true);
  assert.equal(task.scroll?.completionStatus,'COMPLETED');
  await new Promise(resolve=>setTimeout(resolve,700)); // Flush fire-and-forget numeric telemetry.

  const local = requests.filter(req=>{
    try {return new URL(req.url).origin==='http://127.0.0.1:4317';}catch{return false;}
  });
  const otherHttp=requests.filter(req=>/^https?:/i.test(req.url)&&
    !local.includes(req));
  assert.equal(otherHttp.length,0,'An outbound request targeted an unexpected HTTP origin.');
  const steps=local.filter(req=>new URL(req.url).pathname==='/api/agent/step'&&req.method==='POST');
  const telemetry=local.filter(req=>new URL(req.url).pathname==='/api/metrics'&&req.method==='POST');
  assert.ok(steps.length>=2,'No actual planner step requests were observed.');
  assert.ok(telemetry.length>=1,'No actual telemetry request was observed.');
  assert.ok(steps.every(item=>responsesById.get(item.id)===200),
    'An observed authenticated planner HTTP request was not accepted.');
  assert.ok(telemetry.every(item=>responsesById.get(item.id)===202),
    'An observed authenticated numeric telemetry HTTP request was not accepted.');

  async function bodyOf(request){
    if(request.body!==null)return request.body;
    assert.equal(request.hasPostData,true,'A required POST had no request body.');
    const response=await call('Network.getRequestPostData',{requestId:request.id});
    assert.equal(typeof response.postData,'string');
    return response.postData;
  }
  const forbidden=[
    'luv.tankha.sih@example.com','9876543210','ABCDE1234F',
    'NeverTransmitThis','221B Test Road','1234 5678 9012 3456',
  ];
  let images=0, verifiedProofs=0, safeBodies=0;
  for(const item of steps){
    const raw=await bodyOf(item);
    assert.ok(forbidden.every(value=>!raw.includes(value)),
      'A seeded private fixture value crossed the actual planner HTTP boundary.');
    const payload=JSON.parse(raw);
    assert.ok(!Object.hasOwn(payload.context?.pageMetadata||{},'documentToken')&&
      !Object.hasOwn(payload.context?.pageMetadata||{},'observationId')&&
      !Object.hasOwn(payload.context||{},'uiSnapshot')&&
      !Object.hasOwn(payload.context||{},'redactionBoxes'),
      'A device-only local identity or raw geometry reached the planner request.');
    assertSafeToTransmit(sanitizeObservation(payload));
    safeBodies++;
    if(payload.context?.screenshot){
      images++;
      const proof=payload.context.visualPrivacy;
      assert.equal(proof?.schema,'captain.visual-privacy.v2');
      assert.equal(proof?.rawScreenshotTransmitted,false);
      assert.equal(proof?.coverageVerified,true);
      assert.equal(proof?.maskPolicy,'opaque-raster-v1');
      const bytes=Buffer.from(payload.context.screenshot.split(',')[1],'base64');
      assert.equal(createHash('sha256').update(bytes).digest('hex'),proof.imageSha256);
      assert.equal(bytes.length,proof.outputBytes);
      verifiedProofs++;
    }
  }
  for(const item of telemetry){
    const raw=await bodyOf(item);
    assert.ok(forbidden.every(value=>!raw.includes(value)),
      'A seeded private fixture value crossed actual telemetry HTTP boundary.');
    sanitizeMetricSample(JSON.parse(raw));
  }
  assert.ok(images>=1,'No sanitized screenshot was observed in an actual planner request.');
  console.log(JSON.stringify({
    scope:'real split-Incognito service-worker HTTP egress, synthetic fixture only',
    privateWorkerVerified:true,plannerRequests:steps.length,telemetryRequests:telemetry.length,
    checkedBodies:safeBodies,verifiedImageProofs:verifiedProofs,
    plannerResponsesAccepted:true,telemetryResponsesAccepted:true,
    unexpectedHttpOrigins:otherHttp.length,seededCanaryLeaks:0,
    localIdentityLeaks:0,personalDataUsed:false,
    coverage:'service-worker network requests during one guarded synthetic click; not all browser contexts or real-world detector recall'
  },null,2));
} finally {
  if(child?.exitCode==null && child?.signalCode==null)child?.kill();
  try{socket.close();}catch{}
}
