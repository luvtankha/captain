// Original master-plan Phase 7: bounded, disposable-profile public navigation
// and web search. Never use personal tabs, accounts, search history, or private
// inputs. Only this script's newly created tab may be removed on cleanup.
// --dom-only isolates public navigation from the separately tested visual gate;
// the prior screenshot setting is restored regardless of success/failure.
import assert from 'node:assert/strict';
import { cdp, debugJson, evaluate, extensionPath, findSession } from './reload-in-place.mjs';

const startPage = 'about:blank';
const publicDestination = 'https://example.com/';
const searchTerm = 'capybara habitat'; // public, deliberately non-personal.
const duckduckgo = process.argv.includes('--duckduckgo');
const wikipedia = process.argv.includes('--wikipedia');
const navigationOnly = process.argv.includes('--navigation-only');
const fixtureUrls = new Set([
  'http://127.0.0.1:4317/privacy-fixture.html',
  'http://127.0.0.1:4317/demo.html',
  'http://127.0.0.1:4317/demo.html?q=laptop',
  'http://127.0.0.1:4317/benchmark.html?case=login-form',
  'http://127.0.0.1:4317/visual-fixture.html',
]);
const browser = await debugJson('/json/version');
const { extensions = [] } = await cdp(browser.webSocketDebuggerUrl, 'Extensions.getExtensions');
const installed = extensions.find(item => item.path?.toLowerCase() === extensionPath.toLowerCase());
assert.ok(installed?.id, 'Only the exact CAPTAIN workspace extension may be tested.');
const session = await findSession(installed.id);
assert.ok(session?.controller && session.windowId, 'The dedicated CAPTAIN private controller is unavailable.');
const preflight = await evaluate(session.controller, `(async()=>{
  const controller=await chrome.tabs.getCurrent();
  const tabs=await chrome.tabs.query({windowId:controller.windowId});
  return {incognito:controller.incognito,windowId:controller.windowId,
    tabs:tabs.map(t=>({id:t.id,incognito:t.incognito,url:t.url}))};
})()`);
assert.equal(preflight.incognito, true);
assert.equal(preflight.windowId, session.windowId);
assert.ok(preflight.tabs.every(t => t.incognito &&
  (fixtureUrls.has(t.url) || t.url?.startsWith(`chrome-extension://${installed.id}/`))),
  'Unexpected existing tab in private window. No public test navigation occurred.');
const bindKey = `captainWindow:${session.windowId}`;
const saved = await evaluate(session.controller, `(async()=>({
  binding:(await chrome.storage.session.get(${JSON.stringify(bindKey)}))[${JSON.stringify(bindKey)}],
  sync:await chrome.storage.sync.get('includeScreenshot')
}))()`);
let ownedTab;
const domOnly = process.argv.includes('--dom-only');
let lastState;
async function poll(command) {
  const accepted = await evaluate(session.controller, `chrome.runtime.sendMessage({
    type:'START_TASK',task:${JSON.stringify(command)},tabId:${ownedTab.id}
  })`);
  assert.equal(accepted?.ok, true, 'Real extension refused the public typed command.');
  let sawRunning = false;
  for (let i = 0; i < 340; i++) {
    lastState = await evaluate(session.controller, `chrome.runtime.sendMessage({type:'GET_STATE'}).then(s=>({
      status:s.status,phase:s.phase,completionStatus:s.completionStatus,
      failureClass:s.status==='error' ? (
        s.message==='Local observation failed; page information withheld.'?'observation':
        s.message==='Local visual privacy failed; screenshot withheld.'?'vision':
        s.message==='The page changed during observation; screenshot withheld.'?'stale-lease':
        'other') : null,
      outcomeVerified:s.outcomeVerified,
      actions:(s.history||[]).map(x=>x.action?.type).filter(Boolean)
    }))`);
    if (lastState?.status === 'running') sawRunning = true;
    if (sawRunning && ['complete','error'].includes(lastState?.status)) break;
    await new Promise(resolve => setTimeout(resolve, 350));
  }
  assert.equal(sawRunning, true, 'No real task loop started.');
  assert.equal(lastState?.status, 'complete', 'Public task did not reach a completed state.');
  assert.equal(lastState?.completionStatus, 'COMPLETED', 'Public task outcome is incomplete.');
  assert.equal(lastState?.outcomeVerified, true, 'Public task was not verified by the extension.');
  return { completionStatus: lastState.completionStatus, outcomeVerified: lastState.outcomeVerified,
    actions: lastState.actions };
}
async function tabDetails() {
  return evaluate(session.controller, `(async()=>{
    const tab=await chrome.tabs.get(${ownedTab.id});
    const u=new URL(tab.url||'about:blank');
    return {id:tab.id,windowId:tab.windowId,incognito:tab.incognito,
      host:u.hostname,path:u.pathname,query:u.searchParams.get('q'),
      status:tab.status,pending:!!tab.pendingUrl};
  })()`);
}
let output;
try {
  ownedTab = await evaluate(session.controller, `chrome.tabs.create({
    windowId:${session.windowId},url:${JSON.stringify(startPage)},active:true
  }).then(t=>({id:t.id,incognito:t.incognito,windowId:t.windowId,url:t.url}))`);
  assert.equal(ownedTab?.incognito, true);
  assert.equal(ownedTab?.windowId, session.windowId);
  // Chrome can report an empty URL and status=loading immediately after
  // tabs.create(). That is not the committed about:blank document; waiting for
  // it prevents a false no-content-script error before our first navigation.
  let committed = false;
  for (let i=0;i<40;i++) {
    const tab=await evaluate(session.controller,
      `chrome.tabs.get(${ownedTab.id}).then(t=>({url:t.url,status:t.status,pending:!!t.pendingUrl}))`);
    if(tab.url===startPage&&tab.status==='complete'&&!tab.pending){committed=true;break;}
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.equal(committed,true,'New test tab never committed about:blank.');
  if (process.argv.includes('--probe-only')) {
    const probeDestination = process.argv.includes('--probe-search')
      ? `https://duckduckgo.com/?q=${encodeURIComponent(searchTerm)}`
      : process.argv.includes('--probe-visual-fixture')
      ? 'http://127.0.0.1:4317/visual-fixture.html'
      : process.argv.includes('--probe-privacy-fixture')
      ? 'http://127.0.0.1:4317/privacy-fixture.html'
      : process.argv.includes('--probe-duckduckgo')
      ? 'https://duckduckgo.com/' : process.argv.includes('--probe-wikipedia')
        ? 'https://www.wikipedia.org/' : publicDestination;
    await evaluate(session.controller, `chrome.tabs.update(${ownedTab.id},{url:${JSON.stringify(probeDestination)},active:true})`);
    for (let i=0;i<40;i++) {
      const read = await tabDetails();
      if (read.status === 'complete' && !read.pending) break;
      await new Promise(resolve=>setTimeout(resolve,250));
    }
    const read = await tabDetails();
    let receiver = false, visualObservation = false, domObservation = false;
    try { receiver = !!(await evaluate(session.controller,
      `chrome.tabs.sendMessage(${ownedTab.id},{type:'READINESS'}).then(x=>x?.ready===true)`)); }
    catch { /* No receiver is a recorded failure, never a bypass. */ }
    // These only reveal booleans and bounded counts, never page text or OCR.
    for (const [visual, key] of [[false,'dom'],[true,'visual']]) {
      try {
        const result = await evaluate(session.controller, `chrome.tabs.sendMessage(${ownedTab.id},
          {type:'OBSERVE',captureRequested:${visual}}).then(o=>({
            ok:!o?.error && !!o?.pageMetadata?.documentToken &&
              Number.isInteger(o?.pageMetadata?.domRevision),
            controls:Array.isArray(o?.elements)?o.elements.length:null,
            masks:Array.isArray(o?.redactionBoxes)?o.redactionBoxes.length:null
          }))`);
        if (key === 'dom') domObservation = result;
        else visualObservation = result;
      } catch { /* Fail closed; only the result category leaves this window. */ }
    }
    const shape = await evaluate(session.controller, `chrome.scripting.executeScript({
      target:{tabId:${ownedTab.id}},func:()=>({
        elementCount:document.querySelectorAll('*').length,
        hasCaptainPanel:!!document.getElementById('captain-agent-host'),
        strictStyledCount:document.querySelectorAll('body *,*').length,
        bodyTextLength:document.body?.innerText?.length||0,
        textNodeCount:(()=>{const w=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);let n=0;while(w.nextNode()&&n<5000)n++;return n;})()
      })}).then(x=>x?.[0]?.result||null)`);
    let localCapture = null;
    let panelProtocol = null;
    if (process.argv.includes('--probe-panel-protocol') && receiver) {
      panelProtocol=await evaluate(session.controller,`(async()=>{
        let hideOk=false,hidden=false,restoreOk=false,restored=false;
        try {
          const hide=await chrome.tabs.sendMessage(${ownedTab.id},
            {type:'CAPTURE_PANEL',mode:'hide'});
          hideOk=hide?.ok===true;
          if(hideOk)hidden=await chrome.scripting.executeScript({
            target:{tabId:${ownedTab.id}},func:()=>
              document.getElementById('captain-agent-host')?.style.display==='none'
          }).then(x=>x?.[0]?.result===true);
        }finally{
          const restore=await chrome.tabs.sendMessage(${ownedTab.id},
            {type:'CAPTURE_PANEL',mode:'restore'}).catch(()=>({ok:false}));
          restoreOk=restore?.ok===true;
          if(restoreOk)restored=await chrome.scripting.executeScript({
            target:{tabId:${ownedTab.id}},func:()=>
              document.getElementById('captain-agent-host')?.style.display!=='none'
          }).then(x=>x?.[0]?.result===true);
        }
        return {hideOk,hidden,restoreOk,restored};
      })()`);
    }
    if (process.argv.includes('--probe-hide-owned-panel')) {
      // Synthetic owned tab ONLY: diagnose screenshot pollution by the
      // extension's own floating widget. The entire tab is deleted in finally.
      const hidden=await evaluate(session.controller, `chrome.scripting.executeScript({
        target:{tabId:${ownedTab.id}},func:()=>{
          const host=document.getElementById('captain-agent-host');
          if(!host)return false;host.style.display='none';return true;
        }}).then(x=>x?.[0]?.result===true)`);
      assert.equal(hidden,true,'Only the known CAPTAIN widget may be hidden.');
    }
    if (process.argv.includes('--probe-capture') && visualObservation?.ok) {
      // Raw pixels, OCR, page values and screenshots stay in extension origin.
      // This diagnostic only exposes stage and v2 proof booleans.
      localCapture = await evaluate(session.controller, `(async()=>{
        let stage='observe';
        try {
          const first=await chrome.tabs.sendMessage(${ownedTab.id},{type:'OBSERVE',captureRequested:true});
          if(first?.error||!first?.pageMetadata?.documentToken)return {stage,ok:false};
          stage='capture';
          const screenshot=await chrome.tabs.captureVisibleTab(${session.windowId},{format:'jpeg',quality:82});
          const bitmap=await createImageBitmap(await (await fetch(screenshot)).blob());
          const dimensions={imageWidth:bitmap.width,imageHeight:bitmap.height,
            viewportWidth:first.viewport.width,viewportHeight:first.viewport.height,
            dpr:first.viewport.devicePixelRatio};
          bitmap.close?.();
          stage='reobserve';
          const second=await chrome.tabs.sendMessage(${ownedTab.id},{type:'OBSERVE',captureRequested:true});
          const same=(a,b)=>a?.url===b?.url&&a?.pageMetadata?.documentToken===b?.pageMetadata?.documentToken&&
            a?.pageMetadata?.domRevision===b?.pageMetadata?.domRevision&&
            a?.pageMetadata?.geometryRevision===b?.pageMetadata?.geometryRevision&&
            JSON.stringify(a?.redactionBoxes)===JSON.stringify(b?.redactionBoxes)&&
            JSON.stringify(a?.viewport)===JSON.stringify(b?.viewport);
          if(!same(first,second))return {stage,ok:false,stable:false,dimensions};
          stage='redact';
          const lease=first.pageMetadata;
          // The controller is also the VISION_REDACT receiver. A runtime
          // message sent *from that same page* does not loop back to itself;
          // call the exact production controller worker function here instead.
          const proof=await Promise.race([
            runLocalVision({
              screenshot,viewport:first.viewport,redactionBoxes:first.redactionBoxes,
              uiSnapshot:{lease:{documentToken:lease.documentToken,observationId:lease.observationId,
                domRevision:lease.domRevision,geometryRevision:lease.geometryRevision},
                controls:(first.elements||[]).slice(0,250).map(el=>({ref:el.ref,box:el.bbox,
                  source:el.source,visible:el.visible,enabled:el.enabled,sensitive:el.sensitive,
                  lease:{documentToken:lease.documentToken,observationId:lease.observationId,
                    domRevision:lease.domRevision,geometryRevision:lease.geometryRevision}}))}})
              .then(result=>({ok:true,...result}),()=>({ok:false})),
            new Promise((_,reject)=>setTimeout(()=>reject(Error('Local timeout')),110000))
          ]);
          stage='verify';
          const third=await chrome.tabs.sendMessage(${ownedTab.id},{type:'OBSERVE',captureRequested:true});
          const valid=proof?.ok===true&&proof.visualPrivacy?.schema==='captain.visual-privacy.v2'&&
            proof.visualPrivacy?.maskPolicy==='opaque-raster-v1'&&proof.visualPrivacy?.coverageVerified===true&&
            proof.visualPrivacy?.rawScreenshotTransmitted===false&&proof.screenshot!==screenshot&&same(first,third);
          let nonOpaqueSampleCount=null;
          if(valid&&${process.argv.includes('--probe-pixels')}){
            // Count non-black pixels only INSIDE the trusted controller; no
            // image/word/pixel/coordinate is returned to the test process.
            const checked=await createImageBitmap(await(await fetch(proof.screenshot)).blob());
            try {
              const miniature=new OffscreenCanvas(32,24),ctx=miniature.getContext('2d',{willReadFrequently:true});
              ctx.drawImage(checked,0,0,32,24);
              const data=ctx.getImageData(0,0,32,24).data;
              let count=0;for(let i=0;i<data.length;i+=4)if(Math.max(data[i],data[i+1],data[i+2])>40)count++;
              nonOpaqueSampleCount=count;
            }finally{checked.close?.();}
          }
          return {stage,ok:valid,stable:same(first,third),redacted:proof?.ok===true,dimensions,
            proof:proof?.visualPrivacy?.schema==='captain.visual-privacy.v2',nonOpaqueSampleCount};
        }catch{return {stage,ok:false};}
      })()`,120000);
    }
    let maskStability = null;
    if (process.argv.includes('--probe-stability') && visualObservation?.ok) {
      maskStability=await evaluate(session.controller, `(async()=>{
        const first=await chrome.tabs.sendMessage(${ownedTab.id},{type:'OBSERVE',captureRequested:true});
        const exact=boxes=>JSON.stringify(boxes);
        const sorted=boxes=>JSON.stringify((boxes||[]).map(box=>JSON.stringify(box)).sort());
        const base=first.pageMetadata||{};
        const report={samples:0,sameDocumentAndRevisions:0,sequenceMismatch:0,multisetMismatch:0};
        for(let i=0;i<10;i++){
          await new Promise(resolve=>setTimeout(resolve,600));
          const next=await chrome.tabs.sendMessage(${ownedTab.id},{type:'OBSERVE',captureRequested:true});
          const lease=next?.pageMetadata||{};
          const same=first.url===next?.url&&base.documentToken===lease.documentToken&&
            base.domRevision===lease.domRevision&&base.geometryRevision===lease.geometryRevision&&
            JSON.stringify(first.viewport)===JSON.stringify(next.viewport);
          report.samples++;
          if(same){report.sameDocumentAndRevisions++;
            if(exact(first.redactionBoxes)!==exact(next.redactionBoxes))report.sequenceMismatch++;
            if(sorted(first.redactionBoxes)!==sorted(next.redactionBoxes))report.multisetMismatch++;
          }
        }
        return report;
      })()`,20000);
    }
    output={scope:'owned public diagnostic tab in verified disposable profile',
      host:read.host,path:read.path,status:read.status,contentScriptReady:receiver,
      shape,domObservation,visualObservation,localCapture,panelProtocol,maskStability,incognito:read.incognito,personalDataUsed:false};
  } else {
  if (domOnly) await evaluate(session.controller, `chrome.storage.sync.set({includeScreenshot:false})`);
  await evaluate(session.controller, `chrome.storage.session.set({
    [${JSON.stringify(bindKey)}]:{tabId:${ownedTab.id},windowId:${session.windowId}}
  })`);
  const navigation = await poll('open example.com');
  assert.ok(navigation.actions.includes('navigate'));
  const arrived = await tabDetails();
  assert.equal(arrived.incognito, true);
  assert.equal(arrived.windowId, session.windowId);
  assert.equal(arrived.host.replace(/^www\./,''), 'example.com');
  assert.equal(arrived.path, '/');
  assert.equal(arrived.pending, false);
  if (navigationOnly) {
    output={ scope:'real dedicated private browser, publicly accessible page, no accounts',
      screenshotEnabled:!domOnly, navigationOnly:true, navigation:{...navigation,
        independentlyVerifiedHost:true}, personalDataUsed:false };
  } else {
  const search = await poll(wikipedia
    ? `open wikipedia and search for ${searchTerm}`
    : duckduckgo ? `open duckduckgo and search for ${searchTerm}`
      : `search the web for ${searchTerm}`);
  assert.ok(search.actions.includes('navigate'));
  const results = await tabDetails();
  assert.equal(results.incognito, true);
  assert.equal(results.windowId, session.windowId);
  if (wikipedia) {
    assert.ok(['www.wikipedia.org','en.wikipedia.org'].includes(results.host));
    assert.ok(search.actions.includes('type'), 'Public search control was not used.');
  } else if (duckduckgo) {
    assert.ok(['duckduckgo.com','www.duckduckgo.com','html.duckduckgo.com'].includes(results.host));
    assert.ok(['/','/html/'].includes(results.path));
    assert.ok(search.actions.includes('type'), 'Public search form was not used.');
  } else {
    assert.ok(['google.com','www.google.com'].includes(results.host));
    assert.equal(results.path, '/search');
  }
  if (wikipedia) {
    // Wikipedia can canonicalize its GET query key on the language site.
    const verified = await evaluate(session.controller, `chrome.scripting.executeScript({
      target:{tabId:${ownedTab.id}},func:()=>({
        query:new URL(location.href).searchParams.get('search')||
          new URL(location.href).searchParams.get('q')||'',
        path:location.pathname
      })}).then(x=>x?.[0]?.result||{})`);
    assert.ok(verified.query === searchTerm || results.query === searchTerm,
      'Wikipedia search query was not independently observed.');
  } else assert.equal(results.query, searchTerm);
  assert.equal(results.pending, false);
  output = { scope:'real dedicated private browser, publicly accessible pages, no accounts',
    domOnly, searchProvider:wikipedia?'wikipedia':duckduckgo?'duckduckgo':'google', repeatedTrials:1,
    navigation: { ...navigation, independentlyVerifiedHost:true },
    search: { ...search, independentlyVerifiedQuery:true }, personalDataUsed:false };
  }
  }
} catch (error) {
  let tab;
  try { if(ownedTab) tab=await tabDetails(); } catch {}
  console.log(JSON.stringify({ publicAcceptance:false,stage:lastState?.phase||'preflight',
    lastTaskStatus:lastState?.status||null,failureClass:lastState?.failureClass||null,
    tab:tab&&{host:tab.host,path:tab.path,status:tab.status},
    rawPrivateDataLogged:false },null,2));
  throw error;
} finally {
  // A failed/hung task is cancelled before we remove only our own new tab.
  if (lastState?.status === 'running') {
    try { await evaluate(session.controller, `chrome.runtime.sendMessage({type:'CANCEL_TASK'})`); } catch {}
  }
  if (ownedTab?.id) {
    try {
      await evaluate(session.controller, `(async()=>{
        const tab=await chrome.tabs.get(${ownedTab.id});
        if(!tab.incognito||tab.windowId!==${session.windowId})throw Error('Owned tab moved');
        await chrome.tabs.remove(tab.id);return true;
      })()`);
    } catch { /* Never close a tab whose private identity changed. */ }
  }
  try {
    if (saved.binding) await evaluate(session.controller,
      `chrome.storage.session.set({[${JSON.stringify(bindKey)}]:${JSON.stringify(saved.binding)}})`);
    else await evaluate(session.controller,
      `chrome.storage.session.remove(${JSON.stringify(bindKey)})`);
  } finally {
    if (domOnly) await evaluate(session.controller,
      Object.hasOwn(saved.sync,'includeScreenshot')
        ? `chrome.storage.sync.set(${JSON.stringify(saved.sync)})`
        : `chrome.storage.sync.remove('includeScreenshot')`);
  }
}
console.log(JSON.stringify(output,null,2));
