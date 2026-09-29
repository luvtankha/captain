// Disposable CDP-driven validation of actual unpacked extension origin,
// worker CSP, model bytes, ONNX/WASM inference and output image privacy.
// No personal browser/profile, remote provider or production action involved.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { decodePng } from './phase-06-real-inference.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const profile = join(root, 'tests', 'fixtures', 'phase-06-live-profile');
const port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split(/\r?\n/)[0]);
if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw Error('Disposable Edge debugging port unavailable.');
const origin = `http://127.0.0.1:${port}`;
const targets = await (await fetch(`${origin}/json/list`)).json();
const background = targets.find(target => target.type === 'service_worker' && /\/action-binding-entry\.js$/.test(target.url));
// MV3 workers can legitimately sleep between /json/list calls. This ID was
// observed directly in THIS disposable profile immediately after launch.
const extensionId = background ? new URL(background.url).host : 'mdimbjeanhagcmpcdpdgjjjbeibflkob';
const page = targets.find(target => target.type === 'page' &&
  (target.url === 'about:blank' || target.url === `chrome-extension://${extensionId}/phase-06-live.html`));
if (!page) throw Error('Disposable empty browser target unavailable.');

let sequence = 0; const pending = new Map(), events = [];
const connection = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  connection.addEventListener('open', resolve, { once: true });
  connection.addEventListener('error', reject, { once: true });
});
connection.addEventListener('message', event => {
  let data;
  try { data = JSON.parse(event.data); } catch { return; }
  if (data.id && pending.has(data.id)) {
    const { resolve, reject } = pending.get(data.id); pending.delete(data.id);
    if (data.error) reject(Error(data.error.message)); else resolve(data.result);
  } else if (events.length < 50) events.push({ method: data.method });
});
function call(method, params = {}) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    connection.send(JSON.stringify({ id, method, params }));
  });
}
await call('Page.enable');
await call('Runtime.enable');
const pageUrl = `chrome-extension://${extensionId}/phase-06-live.html`;
const navigation = await call('Page.navigate', { url: pageUrl });
if (navigation.errorText) throw Error(navigation.errorText);
let ready = false;
for (let count = 0; count < 30; count++) {
  await new Promise(resolve => setTimeout(resolve, 200));
  const result = await call('Runtime.evaluate', { expression: 'location.href', returnByValue: true });
  if (result.result?.value === pageUrl) { ready = true; break; }
}
if (!ready) throw Error('Actual extension page failed to navigate.');

const expression = `(async () => {
  const lease = { documentToken: 'synthetic-document-123', observationId: 'synthetic-observation-456', domRevision: 1, geometryRevision: 1 };
  const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 480;
  const ctx = canvas.getContext('2d'); ctx.fillStyle='#edf0f4'; ctx.fillRect(0,0,640,480);
  ctx.fillStyle='#fff'; ctx.fillRect(30,65,550,350);
  ctx.fillStyle='#285fc9'; ctx.fillRect(55,295,158,46);
  ctx.font='20px Arial'; ctx.fillStyle='#222'; ctx.fillText('Synthetic field',55,135);
  ctx.fillText('demo@example.test',55,200);
  const blob = await new Promise(resolve => canvas.toBlob(resolve,'image/jpeg',0.85));
  const screenshot = canvas.toDataURL('image/jpeg',0.85);
  const request = { id: 101, screenshot,
    viewport: { width:640,height:480,devicePixelRatio:1 },
    redactionBoxes: [{ x:45,y:165,width:260,height:55,kind:'EMAIL' }],
    uiSnapshot: { lease, controls: [{ ref:'c1',box:{x:55,y:295,width:158,height:46},source:'dom',visible:true,enabled:true,sensitive:false,lease }] } };
  function workerCall(path,payload,timeoutMs=90000) { return new Promise((resolve,reject) => {
    const worker = new Worker(chrome.runtime.getURL(path));
    const start=performance.now();
    const timeout=setTimeout(()=>{worker.terminate();reject(Error('disposable worker timed out'));},timeoutMs);
    worker.onmessage=event=>{clearTimeout(timeout);worker.terminate();resolve({ ...event.data,wallMs:Math.round(performance.now()-start) });};
    worker.onerror=event=>{clearTimeout(timeout);worker.terminate();reject(Error('worker startup/runtime error: '+event.message));};
    worker.postMessage(payload);
  }); }
  const detector = await workerCall('phase-06-live-worker.js',{ blob,lease },30000);
  const ocr = await workerCall('phase-06-live-ocr-worker.js',{blob},90000);
  const result = await workerCall('vision-worker.js',request,100000);
  let visual = {ok: result.ok===true, genericError: result.error=== 'Local visual privacy failed.',wallMs:result.wallMs};
  if(result.ok){
    const data=result.result;
    const raw=Uint8Array.from(atob(data.screenshot.split(',')[1]),c=>c.charCodeAt(0));
    const digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',raw))].map(x=>x.toString(16).padStart(2,'0')).join('');
    const image=await createImageBitmap(new Blob([raw],{type:'image/jpeg'}));
    const output=document.createElement('canvas');output.width=image.width;output.height=image.height;
    const outputContext=output.getContext('2d',{willReadFrequently:true});outputContext.drawImage(image,0,0);
    const values=outputContext.getImageData(0,0,image.width,image.height).data;
    const p=(x,y)=>[...values.slice((y*image.width+x)*4,(y*image.width+x)*4+3)];
    const proof=data.visualPrivacy;
    visual={ok:true,wallMs:result.wallMs,proof:proof.schema,digestOK:digest===proof.imageSha256,
      coverage:proof.coverageVerified,rawScreenshotTransmitted:proof.rawScreenshotTransmitted,
      pixelMaskCount:proof.pixelMaskCount,dimensions:[image.width,image.height],
      emailPixel:p(80,190),backgroundPixel:p(400,450),
      leakedModelData:/detections|matchedRefs|demo@example\\.test/.test(JSON.stringify(data))};
  }
  return {extensionOrigin:location.origin,model:detector,ocr,visual};
})()`;

const response = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true,
  timeout: 150000, generatePreview: false });
if (response.exceptionDetails) throw Error(`Browser evaluation failed: ${response.exceptionDetails.text} ${response.exceptionDetails.exception?.description || ''}`);
const result = response.result?.value;
if (!result) throw Error('Browser returned no validation result.');
// Independently captured fixture (not user content), rendered inside the
// actual extension and fed to its actual worker rather than to the Node VM.
const fixturePng = await readFile(new URL('../benchmarks/phase-06-isolated-ui.png', import.meta.url));
const fixtureNodePixels = decodePng(fixturePng).pixels;
const fixtureNodeSha256 = createHash('sha256').update(fixtureNodePixels).digest('hex');
const fixtureExpression = `(async()=>{
  const lease={documentToken:'synthetic-document-123',observationId:'synthetic-observation-456',domRevision:1,geometryRevision:1};
  const blob=await (await fetch('data:image/png;base64,${fixturePng.toString('base64')}')).blob();
  const worker=new Worker(chrome.runtime.getURL('phase-06-live-worker.js'));
  const model=await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{worker.terminate();reject(Error('fixture model timeout'));},30000);
    worker.onmessage=e=>{clearTimeout(timer);worker.terminate();resolve(e.data)};
    worker.onerror=e=>{clearTimeout(timer);worker.terminate();reject(Error('fixture worker error'))};
    worker.postMessage({blob,lease});
  });
  const bitmap=await createImageBitmap(blob);
  const canvas=document.createElement('canvas');canvas.width=bitmap.width;canvas.height=bitmap.height;
  canvas.getContext('2d').drawImage(bitmap,0,0);bitmap.close();
  const originalPixels=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
  const pixelSha256=[...new Uint8Array(await crypto.subtle.digest('SHA-256',originalPixels))]
    .map(x=>x.toString(16).padStart(2,'0')).join('');
  const screenshot=canvas.toDataURL('image/jpeg',0.85);
  const payload={id:102,screenshot,viewport:{width:1024,height:768,devicePixelRatio:1},redactionBoxes:[
    {x:287,y:320,width:651,height:46,kind:'EMAIL'}],uiSnapshot:{lease,controls:[{
    ref:'c7',box:{x:287,y:543,width:148.5,height:44},source:'dom',visible:true,enabled:true,sensitive:true,lease}]}};
  const visualWorker=new Worker(chrome.runtime.getURL('vision-worker.js'));
  const visual=await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{visualWorker.terminate();reject(Error('fixture vision timeout'));},100000);
    visualWorker.onmessage=e=>{clearTimeout(timer);visualWorker.terminate();resolve(e.data)};
    visualWorker.onerror=e=>{clearTimeout(timer);visualWorker.terminate();reject(Error('fixture vision worker error'))};
    visualWorker.postMessage(payload);
  });
  let proof=null;
  if(visual.ok){const data=visual.result;
    const bytes=Uint8Array.from(atob(data.screenshot.split(',')[1]),c=>c.charCodeAt(0));
    const digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(x=>x.toString(16).padStart(2,'0')).join('');
    const image=await createImageBitmap(new Blob([bytes],{type:'image/jpeg'}));
    const out=document.createElement('canvas');out.width=image.width;out.height=image.height;
    const context=out.getContext('2d',{willReadFrequently:true});context.drawImage(image,0,0);
    const d=context.getImageData(0,0,image.width,image.height).data;
    const pixel=(x,y)=>[...d.slice((y*image.width+x)*4,(y*image.width+x)*4+3)];
    proof={v2:data.visualPrivacy.schema==='captain.visual-privacy.v2',digestOK:digest===data.visualPrivacy.imageSha256,
      piiPixel:pixel(350,340),matchedSensitivePixel:pixel(320,560),outsidePixel:pixel(800,700),
      leak:/detections|matchedRefs|demo@example\\.test/.test(JSON.stringify(data)),maskCount:data.visualPrivacy.pixelMaskCount};
  }
  const checkWorker=async data=>{
    const target=new Worker(chrome.runtime.getURL('vision-worker.js'));
    return await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{target.terminate();reject(Error('negative-case worker timeout'));},100000);
      target.onmessage=e=>{clearTimeout(timer);target.terminate();resolve(e.data)};
      target.onerror=()=>{clearTimeout(timer);target.terminate();reject(Error('negative-case worker failed'))};
      target.postMessage(data);
    });
  };
  const invalid=await checkWorker({...payload,id:103,screenshot:'data:image/png;base64,AAAA'});
  const missingSnapshot=await checkWorker({...payload,id:104,uiSnapshot:null});
  const stale=await checkWorker({...payload,id:105,uiSnapshot:{...payload.uiSnapshot,
    lease:{...lease,geometryRevision:2}}});
  const unknownBox=await checkWorker({...payload,id:106,redactionBoxes:[{kind:'UNKNOWN'}]});
  const blackout=async response=>{
    if(!response.ok)return false;
    const bytes=Uint8Array.from(atob(response.result.screenshot.split(',')[1]),c=>c.charCodeAt(0));
    const image=await createImageBitmap(new Blob([bytes],{type:'image/jpeg'}));
    const surface=document.createElement('canvas');surface.width=image.width;surface.height=image.height;
    const context=surface.getContext('2d',{willReadFrequently:true});context.drawImage(image,0,0);
    const rgba=context.getImageData(0,0,image.width,image.height).data;
    return response.result.visualPrivacy.coverageVerified===true &&
      response.result.visualPrivacy.rawScreenshotTransmitted===false &&
      [0,((Math.floor(image.height/2)*image.width+Math.floor(image.width/2))*4),
        ((image.height*image.width-1)*4)].every(i=>rgba[i]<=32&&rgba[i+1]<=32&&rgba[i+2]<=32);
  };
  return {model,pixelSha256,visionOk:visual.ok===true,visionError:visual.error||null,proof,
    negative:{invalidScreenshotGeneric:invalid.ok===false&&invalid.error==='Local visual privacy failed.',
      missingSnapshotBlackout:await blackout(missingSnapshot),staleLeaseBlackout:await blackout(stale),
      unknownPIIBoxBlackout:await blackout(unknownBox)}};
})()`;
const fixtureResponse = await call('Runtime.evaluate', { expression: fixtureExpression, awaitPromise: true, returnByValue: true, timeout:150000 });
if(fixtureResponse.exceptionDetails) throw Error(`Real browser fixture failed: ${fixtureResponse.exceptionDetails.exception?.description||fixtureResponse.exceptionDetails.text}`);
result.fixture=fixtureResponse.result?.value;
result.fixture.nodeDecoderPixelSha256=fixtureNodeSha256;
connection.close();
await writeFile(new URL('../benchmarks/phase-06-live-browser.json', import.meta.url), JSON.stringify({browser:'Edge headless disposable unpacked MV3 extension', ...result},null,2)+'\n');
console.log(JSON.stringify(result,null,2));
if (!result.model?.ok || result.model?.modelSha256 !== 'd29b6210d171e3dc5454e09847aaabce6a0255eaefa565b639e1301a9e933ef9' ||
    !result.ocr?.ok || !result.ocr?.complete || result.ocr?.fullBlackout ||
    !result.visual?.ok || !result.visual?.digestOK || result.visual?.leakedModelData ||
    !result.fixture?.model?.ok || result.fixture.model.count!==0 || !result.fixture?.visionOk ||
    !result.fixture.proof?.v2 || !result.fixture.proof?.digestOK || result.fixture.proof?.leak ||
    result.fixture.proof.piiPixel.some(c=>c>32) || result.fixture.proof.matchedSensitivePixel.some(c=>c>32) ||
    result.fixture.proof.outsidePixel.some(c=>c>32) || result.visual.backgroundPixel.some(c=>c>32) ||
    !Object.values(result.fixture.negative||{}).every(value=>value===true)) process.exitCode=1;
