// Read-only, synthetic-profile diagnostic for the original Phase-4/7 capture
// path. Raw screenshot and observation never leave the trusted extension.
import assert from 'node:assert/strict';
import { debugJson, cdp, evaluate, extensionPath, findSession } from './reload-in-place.mjs';
const browser = await debugJson('/json/version');
const { extensions = [] } = await cdp(browser.webSocketDebuggerUrl, 'Extensions.getExtensions');
const installed = extensions.find(item => item.path?.toLowerCase() === extensionPath.toLowerCase());
assert.ok(installed?.id);
const session = await findSession(installed.id);
assert.ok(session?.windowId);
const tabs = await evaluate(session.controller, `chrome.tabs.query({
  windowId:${session.windowId}
}).then(tabs=>tabs.map(t=>({id:t.id,url:t.url,incognito:t.incognito,active:t.active})))`);
assert.ok(tabs.every(t => t.incognito && (t.url.startsWith(`chrome-extension://${installed.id}/`) ||
  ['http://127.0.0.1:4317/demo.html', 'http://127.0.0.1:4317/demo.html?q=laptop',
   'http://127.0.0.1:4317/privacy-fixture.html',
   'http://127.0.0.1:4317/benchmark.html?case=login-form'].includes(t.url))));
const target = tabs.find(t => t.active && t.url.startsWith('http://127.0.0.1:4317/'));
assert.ok(target, 'The active tab must be a synthetic CAPTAIN fixture.');
const workers = (await debugJson('/json/list')).filter(item =>
  item.type === 'service_worker' &&
  item.url === `chrome-extension://${installed.id}/action-binding-entry.js`);
let report = null;
for (const worker of workers) {
  report = await evaluate(worker, `(async()=>{
    if(!chrome.extension.inIncognitoContext)return null;
    const tab=await chrome.tabs.get(${target.id});
    let at='observe';
    try{
      const first=await chrome.tabs.sendMessage(tab.id,{type:'OBSERVE',captureRequested:true});
      const lease=first?.pageMetadata||{};
      const valid=!!lease.documentToken&&!!lease.observationId&&
        Number.isInteger(lease.domRevision)&&Number.isInteger(lease.geometryRevision)&&
        first?.viewport?.width>0&&first?.viewport?.height>0&&
        Array.isArray(first?.redactionBoxes)&&first.redactionBoxes.length<=500;
      if(!valid)return {at,valid:false,hasLease:!!lease.documentToken&&!!lease.observationId,
        redactionCount:first?.redactionBoxes?.length??-1,hasError:!!first?.error};
      at='capture';
      const screenshot=await chrome.tabs.captureVisibleTab(tab.windowId,{format:'jpeg',quality:82});
      at='reobserve';
      const second=await chrome.tabs.sendMessage(tab.id,{type:'OBSERVE',captureRequested:true});
      const next=second?.pageMetadata||{};
      const same=first.url===second.url&&lease.documentToken===next.documentToken&&
        lease.domRevision===next.domRevision&&lease.geometryRevision===next.geometryRevision&&
        first.viewport.width===second.viewport.width&&
        first.viewport.height===second.viewport.height&&
        JSON.stringify(first.redactionBoxes)===JSON.stringify(second.redactionBoxes);
      if(!${process.argv.includes('--redact')})return {
        at:'done',valid:true,captureBytes:screenshot.length,
        sameVisualObservation:same,originalUrlSame:first.url===second.url
      };
      at='redact';
      const proof=await Promise.race([chrome.runtime.sendMessage({type:'VISION_REDACT',windowId:tab.windowId,
        screenshot,viewport:first.viewport,redactionBoxes:first.redactionBoxes,
        uiSnapshot:{lease:{documentToken:lease.documentToken,observationId:lease.observationId,
          domRevision:lease.domRevision,geometryRevision:lease.geometryRevision},
          controls:(first.elements||[]).slice(0,250).map(el=>({
            ref:el.ref,box:el.bbox,source:el.source,visible:el.visible,
            enabled:el.enabled,sensitive:el.sensitive,lease:{
              documentToken:lease.documentToken,observationId:lease.observationId,
              domRevision:lease.domRevision,geometryRevision:lease.geometryRevision
            }}))}}),
        new Promise((_,reject)=>setTimeout(()=>reject(Error('Synthetic visual worker reply timed out')),12000))
      ]);
      const third=await chrome.tabs.sendMessage(tab.id,{type:'OBSERVE',captureRequested:true});
      const last=third?.pageMetadata||{};
      const afterRedactionStable=first.url===third.url&&
        lease.documentToken===last.documentToken&&lease.domRevision===last.domRevision&&
        lease.geometryRevision===last.geometryRevision&&
        first.viewport.width===third.viewport.width&&
        first.viewport.height===third.viewport.height&&
        first.viewport.devicePixelRatio===third.viewport.devicePixelRatio&&
        JSON.stringify(first.redactionBoxes)===JSON.stringify(third.redactionBoxes);
      const meta=proof?.visualPrivacy;
      const digest=proof?.screenshot&&[...new Uint8Array(await crypto.subtle.digest('SHA-256',
        Uint8Array.from(atob(proof.screenshot.split(',')[1]),c=>c.charCodeAt(0))))].
        map(x=>x.toString(16).padStart(2,'0')).join('');
      const validProof=proof?.ok===true&&meta?.sanitized===true&&
        meta?.rawScreenshotTransmitted===false&&meta?.redactionApplied===true&&
        meta?.maskPolicy==='opaque-raster-v1'&&meta?.coverageVerified===true&&
        meta?.faceModel==='ultraface-rfb-320'&&meta?.imageSha256===digest&&
        proof.screenshot!==screenshot&&meta?.outputBytes===
          Uint8Array.from(atob(proof.screenshot.split(',')[1]),c=>c.charCodeAt(0)).length;
      return {at:'done',valid:true,captureBytes:screenshot.length,
        sameVisualObservation:same,originalUrlSame:first.url===second.url,
        visionReturned:proof?.ok===true,hasV2Proof:proof?.visualPrivacy?.schema==='captain.visual-privacy.v2',
        visionError:proof?.ok===false?proof.error:null,
        afterRedactionStable,validProof,proofMaskCount:meta?.pixelMaskCount??0};
    }catch(error){return {at,reason:String(error?.message||'error').slice(0,120)};}
  })()`, 30000);
  if(report)break;
}
assert.ok(report, 'The private CAPTAIN worker was unavailable.');
console.log(JSON.stringify({syntheticOnly:true,activeFixture:true,...report},null,2));
