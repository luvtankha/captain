// Original first-plan Phase 7: actual sanitized-image model -> current cN
// -> extension's guarded executor -> independent page-owned click/readback.
// Synthetic data and only the dedicated CAPTAIN Incognito profile are used.
import assert from 'node:assert/strict';
import { cdp, debugJson, evaluate, extensionPath, findSession, findIncognitoWorker } from './reload-in-place.mjs';

const fixtureUrl = 'http://127.0.0.1:4317/visual-fixture.html';
const expectedChoices = process.argv.includes('--two-choices') ? ['A','B'] : ['A'];
const health = await (await fetch('http://127.0.0.1:4317/health', {
  signal: AbortSignal.timeout(3000)
})).json();
assert.equal(health.planner, 'ollama', 'The approved local model must be active.');
assert.equal(health.model, 'qwen3-vl:2b');
assert.equal(health.authRequired, true);
const browser = await debugJson('/json/version');
const { extensions = [] } = await cdp(browser.webSocketDebuggerUrl,'Extensions.getExtensions');
const installed = extensions.find(item => item.path?.toLowerCase() === extensionPath.toLowerCase());
assert.ok(installed?.id, 'Only the exact installed CAPTAIN source is allowed.');
const session = await findSession(installed.id);
assert.ok(session?.controller && Number.isSafeInteger(session.windowId));
const allowed = new Set([
  'http://127.0.0.1:4317/demo.html',
  'http://127.0.0.1:4317/demo.html?q=laptop',
  'http://127.0.0.1:4317/privacy-fixture.html',
  'http://127.0.0.1:4317/benchmark.html?case=login-form',
  fixtureUrl,
]);
const preflight = await evaluate(session.controller,`(async()=>{
  const self=await chrome.tabs.getCurrent(), tabs=await chrome.tabs.query({windowId:self.windowId});
  return {private:self.incognito,windowId:self.windowId,
    tabs:tabs.map(t=>({incognito:t.incognito,url:t.url}))};
})()`);
assert.equal(preflight.private, true);
assert.equal(preflight.windowId, session.windowId);
assert.ok(preflight.tabs.every(t=>t.incognito &&
  (allowed.has(t.url) || t.url?.startsWith(`chrome-extension://${installed.id}/`))),
  'Unreviewed private tab: no synthetic test will run.');

const bindKey=`captainWindow:${session.windowId}`;
const prior=await evaluate(session.controller,`(async()=>({
  binding:(await chrome.storage.session.get(${JSON.stringify(bindKey)}))[${JSON.stringify(bindKey)}],
  settings:await chrome.storage.sync.get('includeScreenshot')
}))()`);
const reports=[];
let ownedTab, taskRunning=false;
try {
  for (const choice of expectedChoices) {
    ownedTab=await evaluate(session.controller,`chrome.tabs.create({
      windowId:${session.windowId},url:${JSON.stringify(fixtureUrl)},active:true
    }).then(t=>({id:t.id,url:t.url,incognito:t.incognito,windowId:t.windowId}))`);
    assert.equal(ownedTab?.incognito,true);
    assert.equal(ownedTab?.windowId,session.windowId);
    let ready=false;
    for(let i=0;i<40;i++){
      try{
        ready=await evaluate(session.controller,`(async()=>{
          const tab=await chrome.tabs.get(${ownedTab.id});
          if(!tab.incognito||tab.windowId!==${session.windowId}||
            tab.url!==${JSON.stringify(fixtureUrl)}||tab.status!=='complete'||tab.pendingUrl)return false;
          return (await chrome.tabs.sendMessage(tab.id,{type:'READINESS'}))?.ready===true;
        })()`);
        if(ready)break;
      }catch{}
      await new Promise(resolve=>setTimeout(resolve,150));
    }
    assert.equal(ready,true,'Exact synthetic fixture must be ready.');
    // Only this owned synthetic tab: keep page controls/labels/URL the same
    // while changing ONLY visual background colors between the A/B trials.
    // The ordinary production capture path now hides/restores its own panel.
    // --test-hide-panel retains the old A/B diagnostic isolation as a control.
    // No page image is returned to Node in either mode.
    const setup=await evaluate(session.controller,`chrome.scripting.executeScript({
      target:{tabId:${ownedTab.id}},func:(choice)=>{
        const host=document.getElementById('captain-agent-host');
        const buttons=[...document.querySelectorAll('button[data-choice]')];
        if(!host||buttons.length!==3||buttons.some(b=>b.textContent.trim()!=='Inspect'))return false;
        if(${process.argv.includes('--test-hide-panel')})host.style.display='none';
        for(const button of buttons){
          button.style.background=button.dataset.choice===choice?'#119b50':'#e4e7f0';
          button.style.color=button.dataset.choice===choice?'#fff':'#262932';
        }
        return buttons.filter(button=>getComputedStyle(button).backgroundColor==='rgb(17, 155, 80)').length===1;
      },args:[${JSON.stringify(choice)}]
    }).then(x=>x?.[0]?.result===true)`);
    assert.equal(setup,true,'The known fixture must have exactly one visual green target.');
    const shape=await evaluate(session.controller,`(async()=>{
      const face=(await chrome.scripting.executeScript({target:{tabId:${ownedTab.id}},
        func:()=>{const r=document.querySelector('.face-sample')?.getBoundingClientRect();
          return r?{x:r.x,y:r.y,width:r.width,height:r.height}:null;}
      }))?.[0]?.result;
      const o=await chrome.tabs.sendMessage(${ownedTab.id},{type:'OBSERVE',captureRequested:true});
      const faceCovered=!!face && face.width>0 && face.height>0 &&
        (o?.redactionBoxes||[]).some(b=>{
          if(!['RASTER_CONTENT','BACKGROUND_IMAGE'].includes(b.kind))return false;
          const w=Math.max(0,Math.min(face.x+face.width,b.x+b.width)-Math.max(face.x,b.x));
          const h=Math.max(0,Math.min(face.y+face.height,b.y+b.height)-Math.max(face.y,b.y));
          return w*h>=face.width*face.height*0.95;
        });
      return {
        ready:!o?.error && !!o?.pageMetadata?.documentToken,
        controls:(o?.elements||[]).filter(e=>e.name?.toLowerCase()==='inspect').length,
        masks:o?.redactionBoxes?.length||0,
        privateEmail:Number(o?.piiCounts?.EMAIL||0)>0,
        privatePhone:Number(o?.piiCounts?.PHONE||0)>0,
        privateRaster:Number(o?.piiCounts?.RASTER_CONTENT||0)>0,
        faceCovered,
        privateValuesWithheld:!(/luv\.tankha\.sih@example\.com|9876543210/.test(o?.pageText||'')),
        sameLabels:(o?.elements||[]).filter(e=>e.name?.toLowerCase()==='inspect')
          .every(e=>e.name==='Inspect')
      };
    })()`);
    assert.equal(shape?.ready,true);
    assert.equal(shape?.controls,3);
    assert.equal(shape?.sameLabels,true);
    assert.ok(shape?.masks>0,'Synthetic unknown raster must remain masked.');
    assert.equal(shape?.privateEmail,true,'Synthetic email region must be recognized locally.');
    assert.equal(shape?.privatePhone,true,'Synthetic phone region must be recognized locally.');
    assert.equal(shape?.privateRaster,true,'Synthetic face/raster region must be masked locally.');
    assert.equal(shape?.faceCovered,true,'The actual synthetic face crop must have an opaque mask covering its pixels.');
    assert.equal(shape?.privateValuesWithheld,true,'Raw synthetic PII escaped the local observation.');
    if(process.argv.includes('--pixel-probe')){
      // Test-only readback INSIDE the trusted private service worker. The
      // controller is the receiver of VISION_REDACT and Chrome does not route
      // runtime.sendMessage to its sending frame, so sending FROM the controller
      // would falsely return undefined. Source and sanitized JPEGs stay inside
      // the extension; only boolean evidence leaves this worker via CDP.
      const privateWorker=await findIncognitoWorker(installed.id,session.windowId);
      assert.ok(privateWorker?.worker,'Trusted CAPTAIN private service worker unavailable.');
      const pixels=await evaluate(privateWorker.worker,`(async()=>{
        if(!chrome.extension.inIncognitoContext)throw Error('Private worker required');
        const tab=await chrome.tabs.get(${ownedTab.id});
        if(!tab.incognito||tab.windowId!==${session.windowId}||tab.url!==${JSON.stringify(fixtureUrl)}||
          tab.pendingUrl||(await chrome.tabs.query({active:true,windowId:tab.windowId}))[0]?.id!==tab.id)
          throw Error('Synthetic capture identity changed');
        const hidden=await chrome.tabs.sendMessage(tab.id,{type:'CAPTURE_PANEL',mode:'hide'});
        if(hidden?.ok!==true)throw Error('Cannot hide CAPTAIN panel');
        try{
          const first=await chrome.tabs.sendMessage(tab.id,{type:'OBSERVE',captureRequested:true});
          const raw=await chrome.tabs.captureVisibleTab(tab.windowId,{format:'jpeg',quality:82});
          const after=await chrome.tabs.sendMessage(tab.id,{type:'OBSERVE',captureRequested:true});
          const same=(a,b)=>a?.pageMetadata?.documentToken&&
            a.pageMetadata.documentToken===b?.pageMetadata?.documentToken&&
            a.pageMetadata.domRevision===b.pageMetadata.domRevision&&
            a.pageMetadata.geometryRevision===b.pageMetadata.geometryRevision&&a.url===b.url&&
            a.viewport.width===b.viewport.width&&a.viewport.height===b.viewport.height&&
            a.viewport.devicePixelRatio===b.viewport.devicePixelRatio&&
            JSON.stringify(a.redactionBoxes)===JSON.stringify(b.redactionBoxes);
          if(!same(first,after))throw Error('Visual lease changed before local redaction');
          const proof=await chrome.runtime.sendMessage({type:'VISION_REDACT',windowId:tab.windowId,
            screenshot:raw,viewport:first.viewport,redactionBoxes:first.redactionBoxes,
            uiSnapshot:{lease:{documentToken:first.pageMetadata.documentToken,
              observationId:first.pageMetadata.observationId,
              domRevision:first.pageMetadata.domRevision,geometryRevision:first.pageMetadata.geometryRevision},
              controls:(first.elements||[]).slice(0,250).map(el=>({ref:el.ref,box:el.bbox,
                source:el.source,visible:el.visible,enabled:el.enabled,sensitive:el.sensitive,
                lease:{documentToken:first.pageMetadata.documentToken,
                  observationId:first.pageMetadata.observationId,
                  domRevision:first.pageMetadata.domRevision,geometryRevision:first.pageMetadata.geometryRevision}}))}});
          const afterProof=await chrome.tabs.sendMessage(tab.id,{type:'OBSERVE',captureRequested:true});
          if(!same(first,afterProof))throw Error('Visual lease changed after local redaction');
          if(proof?.ok!==true||proof.visualPrivacy?.schema!=='captain.visual-privacy.v2'||
            proof.visualPrivacy.coverageVerified!==true||proof.visualPrivacy.rawScreenshotTransmitted!==false||
            proof.screenshot===raw)return {nativeV2DigestChecked:false,
              visionResponded:!!proof,visionAccepted:proof?.ok===true,
              nativeSchema:proof?.visualPrivacy?.schema==='captain.visual-privacy.v2',
              coverageVerified:proof?.visualPrivacy?.coverageVerified===true,
              rawScreenshotTransmitted:proof?.visualPrivacy?.rawScreenshotTransmitted===true};
          const bytes=Uint8Array.from(atob(proof.screenshot.split(',')[1]),c=>c.charCodeAt(0));
          const digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))]
            .map(x=>x.toString(16).padStart(2,'0')).join('');
          if(digest!==proof.visualPrivacy.imageSha256||bytes.length!==proof.visualPrivacy.outputBytes)
            throw Error('Sanitized JPEG proof mismatch');
          const bitmap=await createImageBitmap(new Blob([bytes],{type:'image/jpeg'}));
          try{
            const canvas=new OffscreenCanvas(bitmap.width,bitmap.height);
            const ctx=canvas.getContext('2d',{willReadFrequently:true});ctx.drawImage(bitmap,0,0);
            const controls=(first.elements||[]).filter(e=>e.name==='Inspect'&&e.bbox&&e.visible!==false)
              .sort((a,b)=>a.bbox.y-b.bbox.y);
            if(controls.length!==3)throw Error('Three observed synthetic controls required');
            const green=controls.map(el=>{
              const x=Math.floor((el.bbox.x+Math.min(8,el.bbox.width/4))*bitmap.width/first.viewport.width);
              const y=Math.floor((el.bbox.y+el.bbox.height/2)*bitmap.height/first.viewport.height);
              const rgb=ctx.getImageData(x,y,1,1).data;
              return rgb[1]>75&&rgb[1]>rgb[0]*1.25&&rgb[1]>rgb[2]*1.1&&rgb[0]<120;
            });
            return {nativeV2DigestChecked:true,onlyOneGreen:green.filter(Boolean).length===1,
              greenCount:green.filter(Boolean).length,
              visibleGreenIndex:green.indexOf(true),opaqueMasks:proof.visualPrivacy.pixelMaskCount,
              rawImageReturnedToNode:false};
          }finally{bitmap.close?.();}
        }finally{
          const restored=await chrome.tabs.sendMessage(tab.id,{type:'CAPTURE_PANEL',mode:'restore'});
          if(restored?.ok!==true)throw Error('CAPTAIN panel restore failed');
        }
      })()`,120000);
      if(!pixels.nativeV2DigestChecked)
        console.log(JSON.stringify({syntheticPixelProbeAccepted:false,expectedChoice:choice,
          visionResponded:pixels.visionResponded,visionAccepted:pixels.visionAccepted,
          nativeSchema:pixels.nativeSchema,coverageVerified:pixels.coverageVerified,
          rawScreenshotTransmitted:pixels.rawScreenshotTransmitted}));
      assert.equal(pixels.nativeV2DigestChecked,true);
      if(!pixels.onlyOneGreen)
        console.log(JSON.stringify({syntheticPixelProbeAccepted:false,expectedChoice:choice,
          nativeV2DigestChecked:true,greenControlCount:pixels.greenCount,
          opaqueMaskCount:pixels.opaqueMasks,rawImageReturnedToNode:false}));
      assert.equal(pixels.onlyOneGreen,true,'Opaque masking hid the visually distinct public target.');
      assert.equal(pixels.visibleGreenIndex,['A','B','C'].indexOf(choice),
        'Sanitized screenshot does not preserve the expected synthetic green button.');
      reports.push({expectedChoice:choice,pixelAudit:pixels});
      await evaluate(session.controller,`chrome.tabs.remove(${ownedTab.id})`);
      ownedTab=null;
      continue;
    }
    await evaluate(session.controller,`chrome.storage.sync.set({includeScreenshot:true})`);
    await evaluate(session.controller,`chrome.storage.session.set({
      [${JSON.stringify(bindKey)}]:{tabId:${ownedTab.id},windowId:${session.windowId}}
    })`);
    const accepted=await evaluate(session.controller,`chrome.runtime.sendMessage({
      type:'START_TASK',
      task:'Use the sanitized screenshot to choose and click the GREEN Inspect button, not the gray Inspect buttons.',
      tabId:${ownedTab.id}
    })`);
    assert.equal(accepted?.ok,true,'CAPTAIN refused the visual-only task.');
    taskRunning=true;
    let state=null,started=false;
    // One fail-closed MODEL_TIMEOUT recovery can consume two full local
    // planner deadlines plus two independent screenshot/privacy passes.
    // The test must observe the terminal verdict, not mistake its first
    // bounded recovery for a missing worker or a completed visual action.
    for(let i=0;i<760;i++){
      state=await evaluate(session.controller,`chrome.runtime.sendMessage({type:'GET_STATE'}).then(s=>({
        status:s.status,phase:s.phase,completionStatus:s.completionStatus,
        errorClass:s.status==='error' ? (
          s.message==='Local visual privacy failed; screenshot withheld.'?'vision':
          s.message==='Local observation failed; page information withheld.'?'observation':
          /ollama|model|planner|json/i.test(s.message||'')?'planner':'other') : null,
        outcomeVerified:s.outcomeVerified,
        actions:(s.history||[]).map(h=>({type:h.action?.type,planner:h.planner||null,
          target:h.action?.target?.ref||null,ok:h.result?.ok===true}))
      }))`,10000);
      if(state?.status==='running')started=true;
      if(started && ['complete','error'].includes(state?.status))break;
      await new Promise(resolve=>setTimeout(resolve,350));
    }
    taskRunning=false;
    const page=await evaluate(session.controller,`chrome.scripting.executeScript({
      target:{tabId:${ownedTab.id}},world:'MAIN',func:()=>({
        choice:document.querySelector('#selected')?.dataset.choice||null,
        clicks:globalThis.__captainFixtureClickCount||0,
        panelVisible:document.getElementById('captain-agent-host')?.style.display!=='none'
      })
    }).then(x=>x?.[0]?.result||null)`);
    const plan=(state?.actions||[]).find(a=>a.type==='click');
    const result={scope:'actual CAPTAIN extension, one owned synthetic Incognito fixture',
      expectedChoice:choice,terminalState:state?.status||null,
      completionStatus:state?.completionStatus||null,
      actualPlanner:plan?.planner||null,clickExecuted:plan?.ok===true,
      actionTypes:(state?.actions||[]).map(a=>a.type),
      pageChoiceVerified:page?.choice===choice,exactlyOnePageClick:page?.clicks===1,
      panelRestored:page?.panelVisible===true,
      noPersonalData:true,screenshotSettingEnabled:true};
    reports.push(result);
    if(state?.status!=='complete') console.log(JSON.stringify({visualGroundingAccepted:false,
      failureClass:state?.errorClass||'unknown',phase:state?.phase||null,
      actionTypes:result.actionTypes,planner:result.actualPlanner,pageChoiceVerified:result.pageChoiceVerified,
      exactlyOnePageClick:result.exactlyOnePageClick,rawImageLogged:false}));
    assert.equal(started,true,'No live CAPTAIN task loop started.');
    assert.equal(state?.status,'complete','Real visual task did not finish.');
    if (process.argv.includes('--expect-blocked')) {
      assert.equal(state?.completionStatus,'BLOCKED','Fully masked visual task must be blocked.');
      assert.equal(plan,undefined,'No model-selected click may be executed without visual evidence.');
      assert.equal(page?.clicks,0,'Blocked task must not click the page.');
      assert.equal(page?.choice,null,'Blocked task must not select a fixture choice.');
    } else {
    assert.equal(plan?.planner,'ollama','A DOM/fast-command click does not prove visual grounding.');
    assert.equal(plan?.ok,true,'Actual model-selected action did not execute.');
    assert.equal(page?.choice,choice,'Independent page-owned selected control disagrees with image.');
    assert.equal(page?.clicks,1,'Exactly one current target must be clicked.');
    }
    if(!process.argv.includes('--test-hide-panel'))
      assert.equal(page?.panelVisible,true,'CAPTAIN panel must be restored after safe capture.');
    const current=await evaluate(session.controller,`chrome.tabs.get(${ownedTab.id})
      .then(t=>({id:t.id,incognito:t.incognito,windowId:t.windowId,url:t.url}))`);
    assert.equal(current?.url,fixtureUrl);
    assert.equal(current?.incognito,true);
    assert.equal(current?.windowId,session.windowId);
    await evaluate(session.controller,`chrome.tabs.remove(${ownedTab.id})`);
    ownedTab=null;
  }
} finally {
  if(taskRunning)try{await evaluate(session.controller,
    `chrome.runtime.sendMessage({type:'CANCEL_TASK'})`);}catch{}
  if(ownedTab?.id)try{await evaluate(session.controller,`(async()=>{
    const tab=await chrome.tabs.get(${ownedTab.id});
    if(tab.incognito&&tab.windowId===${session.windowId}&&tab.url===${JSON.stringify(fixtureUrl)})
      await chrome.tabs.remove(tab.id);
    return true;
  })()`);}catch{}
  try{
    if(prior.binding)await evaluate(session.controller,
      `chrome.storage.session.set({[${JSON.stringify(bindKey)}]:${JSON.stringify(prior.binding)}})`);
    else await evaluate(session.controller,
      `chrome.storage.session.remove(${JSON.stringify(bindKey)})`);
  }finally{
    await evaluate(session.controller,Object.hasOwn(prior.settings,'includeScreenshot')
      ?`chrome.storage.sync.set(${JSON.stringify(prior.settings)})`
      :`chrome.storage.sync.remove('includeScreenshot')`);
  }
}
console.log(JSON.stringify(process.argv.includes('--pixel-probe')
  ?{pixelAuditOnly:true,trials:reports}
  :process.argv.includes('--expect-blocked')
    ?{visualGroundingBlocked:true,trials:reports}
    :{visualGroundingAccepted:true,trials:reports},null,2));
