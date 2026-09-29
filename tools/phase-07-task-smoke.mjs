// Original master-plan Phase 7: actual typed extension -> Incognito tab ->
// local sanitized planner -> guarded browser action. Only CAPTAIN's dedicated
// profile and synthetic 127.0.0.1 fixture. No personal tabs or accounts.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { debugJson, cdp, evaluate, extensionPath, findSession } from './reload-in-place.mjs';

const privacyClick = process.argv.includes('--click-privacy');
const search = process.argv.includes('--search');
const domOnly = process.argv.includes('--dom-only');
const localFixture = process.argv.includes('--privacy') || privacyClick
  ? 'http://127.0.0.1:4317/privacy-fixture.html'
  : 'http://127.0.0.1:4317/demo.html';
const syntheticFixtures = new Set([
  'http://127.0.0.1:4317/privacy-fixture.html',
  'http://127.0.0.1:4317/demo.html',
  'http://127.0.0.1:4317/demo.html?q=laptop',
  'http://127.0.0.1:4317/benchmark.html?case=login-form'
  ,'http://127.0.0.1:4317/visual-fixture.html'
  ,'about:blank'
]);
const health = await fetch('http://127.0.0.1:4317/health', { signal: AbortSignal.timeout(3000) });
assert.equal(health.ok, true, 'Start the local CAPTAIN companion first.');
assert.equal((await health.json()).service, 'captain');
const browser = await debugJson('/json/version');
const { extensions = [] } = await cdp(browser.webSocketDebuggerUrl, 'Extensions.getExtensions');
const installed = extensions.find(item => item.path?.toLowerCase() === extensionPath.toLowerCase());
assert.ok(installed?.id, 'The exact workspace extension must be installed in CAPTAIN\'s disposable browser.');
const session = await findSession(installed.id);
assert.ok(session?.windowId && session?.controller?.webSocketDebuggerUrl,
  'A live private CAPTAIN controller is required; run npm run demo first.');

const preflight = await evaluate(session.controller, `(async()=>{
  const self=await chrome.tabs.getCurrent();
  const tabs=await chrome.tabs.query({windowId:self.windowId});
  return {incognito:self.incognito,windowId:self.windowId,tabs:tabs.map(tab=>({
    id:tab.id,incognito:tab.incognito,url:tab.url
  }))};
})()`);
assert.equal(preflight.incognito, true);
assert.equal(preflight.windowId, session.windowId);
assert.ok(preflight.tabs.every(tab => tab.incognito === true &&
  (tab.url?.startsWith(`chrome-extension://${installed.id}/`) || syntheticFixtures.has(tab.url))),
  'The dedicated private CAPTAIN window contains a non-synthetic tab. No commands were sent.');

if (process.argv.includes('--worker-only')) {
  // The popup document is deliberately hidden while a webpage is captured.
  // Creating a private Worker there tests a throttled, obsolete path; probe
  // the ACTUAL incognito offscreen worker through the trusted service worker.
  const candidates = (await debugJson('/json/list')).filter(target => target.type === 'service_worker' &&
    target.url?.startsWith(`chrome-extension://${installed.id}/`) && target.webSocketDebuggerUrl);
  let privateWorker;
  for (const target of candidates) {
    const context = await cdp(target.webSocketDebuggerUrl, 'Runtime.evaluate', {
      expression: 'chrome.extension?.inIncognitoContext === true', returnByValue: true }, 5000);
    if (context.result?.value === true) privateWorker = target;
  }
  assert.ok(privateWorker, 'The exact CAPTAIN private service worker is unavailable.');
  const script = `(async()=>{
    const url=chrome.runtime.getURL('offscreen.html');
    const filter=incognito=>({contextTypes:['OFFSCREEN_DOCUMENT'],documentUrls:[url],incognito});
    if((await chrome.runtime.getContexts(filter(false))).length)return {ok:false,kind:'normal-host-present'};
    if(!(await chrome.runtime.getContexts(filter(true))).length)
      await chrome.offscreen.createDocument({url:'offscreen.html',reasons:['WORKERS','BLOBS'],
        justification:'Bounded private synthetic vision acceptance test'});
    if((await chrome.runtime.getContexts(filter(true))).length!==1)return {ok:false,kind:'private-host-unavailable'};
    const canvas=new OffscreenCanvas(640,480),cx=canvas.getContext('2d',{alpha:false});
    if(!cx)throw Error('Synthetic image canvas unavailable');
    cx.fillStyle='#fff';cx.fillRect(0,0,640,480);cx.fillStyle='#111';cx.font='22px Arial';
    cx.fillText('Synthetic public page',40,100);
    const blob=await canvas.convertToBlob({type:'image/jpeg',quality:0.85});
    const bytes=new Uint8Array(await blob.arrayBuffer());let binary='';
    for(let i=0;i<bytes.length;i+=0x8000)binary+=String.fromCharCode(...bytes.subarray(i,i+0x8000));
    const screenshot='data:image/jpeg;base64,'+btoa(binary);
    const response=await chrome.runtime.sendMessage({type:'VISION_REDACT',visionHost:'offscreen',
      windowId:${session.windowId},screenshot,viewport:{width:640,height:480,devicePixelRatio:1},
      redactionBoxes:[{x:0,y:0,width:640,height:480,kind:'PII'}]});
    if(response?.ok!==true)return {ok:false,kind:'private-vision-failed'};
    const proof=response.visualPrivacy,output=response.screenshot;
    if(proof?.schema!=='captain.visual-privacy.v2'||proof.coverageVerified!==true||
      proof.rawScreenshotTransmitted!==false||output===screenshot||typeof output!=='string')
      return {ok:false,kind:'invalid-proof'};
    const jpeg=Uint8Array.from(atob(output.split(',')[1]),x=>x.charCodeAt(0));
    const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',jpeg))]
      .map(x=>x.toString(16).padStart(2,'0')).join('');
    if(hash!==proof.imageSha256||jpeg.length!==proof.outputBytes)
      return {ok:false,kind:'digest-mismatch'};
    return {ok:true,proof:proof.schema,blackoutCount:proof.pixelMaskCount,host:'private-offscreen'};
  })()`;
  const result = await cdp(privateWorker.webSocketDebuggerUrl, 'Runtime.evaluate', {
    expression: script, awaitPromise: true, returnByValue: true }, 120000);
  assert.equal(!!result.exceptionDetails, false, 'Private offscreen probe failed.');
  const worker = result.result?.value;
  console.log(JSON.stringify({ privateWindow:true,syntheticOnly:true,worker },null,2));
  assert.equal(worker.ok,true,'Real extension local vision worker did not produce a verified image.');
  process.exit(0);
}

let fixture = preflight.tabs.find(tab => tab.url === localFixture);
if (!fixture && search) {
  const previous = preflight.tabs.find(tab => tab.url === 'http://127.0.0.1:4317/demo.html?q=laptop');
  if (previous) fixture = await evaluate(session.controller, `chrome.tabs.update(${previous.id},{
    url:${JSON.stringify(localFixture)},active:true
  }).then(tab=>({id:tab.id,url:tab.url}))`);
}
if (!fixture) {
  fixture = await evaluate(session.controller, `chrome.tabs.create({windowId:${session.windowId},
    url:${JSON.stringify(localFixture)},active:true}).then(tab=>({id:tab.id,url:tab.url}))`);
  assert.ok(Number.isInteger(fixture.id));
}
if (privacyClick) {
  // A just-created tab can temporarily report an empty URL while committing.
  // Wait for the exact known fixture to finish before its bounded reset;
  // never reload a different or still-pending page.
  let committed = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    const tab = await evaluate(session.controller, `chrome.tabs.get(${fixture.id}).then(t=>({
      id:t.id,incognito:t.incognito,windowId:t.windowId,url:t.url,
      status:t.status,pending:!!t.pendingUrl
    }))`);
    if (!tab.incognito || tab.windowId !== session.windowId ||
        (tab.url && tab.url !== localFixture)) throw new Error('Unsafe fixture reload');
    if (tab.url === localFixture && tab.status === 'complete' && !tab.pending) { committed = true; break; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(committed, true, 'Private fixture did not finish committing before reset.');
  await evaluate(session.controller, `chrome.tabs.reload(${fixture.id})`);
}
// captureVisibleTab only captures the current active tab. Do not ever capture
// the controller or a different tab while testing a background fixture.
await evaluate(session.controller, `chrome.tabs.update(${fixture.id},{active:true})`);
// The controller intentionally follows its own per-window task binding, not
// arbitrary tabs. Bind only the verified synthetic fixture in the disposable
// window, as the page panel does when a user opens CAPTAIN from that page.
await evaluate(session.controller, `chrome.storage.session.set({
  ['captainWindow:'+ ${session.windowId}]:{
    tabId:${fixture.id},windowId:${session.windowId}
  }
})`);

// Do not start a task on a blank, stale or uninstrumented target.
let fixtureReady = false;
for (let attempt = 0; attempt < 30; attempt++) {
  try {
    fixtureReady = await evaluate(session.controller, `(async()=>{
      const tab=await chrome.tabs.get(${fixture.id});
      if(!tab.incognito||tab.windowId!==${session.windowId}||tab.url!==${JSON.stringify(localFixture)}||
         tab.status!=='complete')return false;
      const ready=await chrome.tabs.sendMessage(tab.id,{type:'READINESS'});
      return !!ready?.ready;
    })()`);
    if (fixtureReady) break;
  } catch { /* Only this freshly created synthetic tab is retried. */ }
  await new Promise(resolve => setTimeout(resolve, 250));
}
assert.equal(fixtureReady, true, 'Synthetic task page and CAPTAIN content script must be ready.');

// One visible public fixture button supplies an independent, page-owned
// confirmation that an observed, locally validated click really occurred.
// Test-only instrumentation does not add a production action hook.
let page;
if (privacyClick || search) {
  // Multiple fixture tabs may share the same URL after repeated demos.
  // A URL-only CDP lookup can instrument a DIFFERENT tab, yielding a false
  // zero-click oracle while the actual task succeeds. Bind by Chrome's exact
  // tabId -> debugger target id instead, without attaching to any tab.
  const targetId = await evaluate(session.controller,
    `chrome.debugger.getTargets().then(targets=>targets.find(t=>t.tabId===${fixture.id})?.id||null)`);
  assert.ok(targetId, 'Synthetic tab has no exact debugger target identity.');
  page = (await debugJson('/json/list')).find(target => target.id === targetId &&
    target.type === 'page' && target.url === localFixture && target.webSocketDebuggerUrl);
  assert.ok(page, 'Exact synthetic page debugger target unavailable.');
}
if (privacyClick) {
  const installed = await evaluate(page, `(()=>{
    const button=document.querySelector('[data-captain-ui="details"]');
    if(!button || button.textContent.trim()!=='View laptop details')return false;
    globalThis.__captainSyntheticClickCount=0;
    button.addEventListener('click',()=>globalThis.__captainSyntheticClickCount++);
    return true;
  })()`);
  assert.equal(installed, true, 'Synthetic public click target was not installed.');
}

async function typedTask(command) {
  const accepted = await evaluate(session.controller, `chrome.runtime.sendMessage({
    type:'START_TASK',task:${JSON.stringify(command)},tabId:${fixture.id}
  })`);
  assert.equal(accepted?.ok, true, 'Real extension did not accept the typed command.');
  let last, sawRunning = false;
  const started = performance.now();
  for (let i = 0; i < 300; i++) {
    last = await evaluate(session.controller, `chrome.runtime.sendMessage({type:'GET_STATE'}).then(s=>({
      status:s.status,step:s.step,completionStatus:s.completionStatus,
      outcomeVerified:s.outcomeVerified,phase:s.phase,
      actions:(s.history||[]).map(item=>item.action?.type).filter(Boolean),
      actionResults:(s.history||[]).map(item=>({type:item.action?.type,ok:item.result?.ok===true})),
      message:typeof s.message==='string'?s.message.slice(0,200):null,
      build:s.build
    }))`);
    if (last?.status === 'running') sawRunning = true;
    if (sawRunning && ['complete', 'error'].includes(last?.status)) break;
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  const output = { command, accepted: true, ...last, durationMs: Math.round(performance.now() - started) };
  assert.equal(sawRunning, true, 'The real extension never entered its task loop.');
  assert.equal(output.status, 'complete', 'The real typed task did not finish: '+JSON.stringify(output));
  if (visual) {
    assert.equal(output.completionStatus, 'PARTIAL',
      'A generic inspection without a configured VLM must not claim task completion.');
    assert.equal(output.outcomeVerified, false);
  } else {
    assert.equal(output.completionStatus, 'COMPLETED');
    assert.equal(output.outcomeVerified, true);
  }
  return output;
}

// Scroll must execute in the real tab and then independently reobserve it.
// Visual inspection exercises the separate capture/privacy gate, not scroll.
const visual = process.argv.includes('--inspect');
const command = privacyClick ? 'click View laptop details' : search ? 'search for laptop' :
  visual ? 'Inspect this synthetic page' : 'Scroll down';
// Existing user-visible DOM-only option, used solely to isolate the guarded
// action path from the independent visual pipeline. Restore the exact prior
// setting even if acceptance fails; this does not change the default policy.
let previousSettings;
if (domOnly) {
  previousSettings = await evaluate(session.controller,
    `chrome.storage.sync.get('includeScreenshot')`);
  await evaluate(session.controller,
    `chrome.storage.sync.set({includeScreenshot:false})`);
}
let scroll;
try { scroll = await typedTask(command); }
finally {
  if (domOnly) await evaluate(session.controller,
    Object.hasOwn(previousSettings, 'includeScreenshot')
      ? `chrome.storage.sync.set(${JSON.stringify(previousSettings)})`
      : `chrome.storage.sync.remove('includeScreenshot')`);
}
if (!visual && !privacyClick && !search) assert.ok(scroll.actions.includes('scroll'), 'The planner did not execute an observed scroll action.');
if (privacyClick) {
  assert.ok(scroll.actions.includes('click'), 'No grounded click was executed after sanitized visual observation.');
  const clicks = await evaluate(page, 'globalThis.__captainSyntheticClickCount');
  assert.equal(clicks, 1, 'Synthetic page did not independently observe exactly one click.');
}
if (search) {
  assert.ok(scroll.actions.includes('type'), 'The search control was not used.');
  const result = await evaluate(page, `(()=>({
    query:document.querySelector('#query')?.value,
    matchingProducts:document.querySelectorAll('#results .product').length
  }))()`);
  assert.deepEqual(result, { query: 'laptop', matchingProducts: 5 },
    'The independent synthetic search result does not match the requested term.');
}
assert.ok(scroll.actions.includes('finish'), 'CAPTAIN did not verify its final state.');

// No personal text, screenshot, OCR word, model output or response payload is
// persisted: this report contains only task type, terminal state and actions.
console.log(JSON.stringify({ scope: 'real extension in dedicated private browser with synthetic localhost fixture',
  extensionBuild: scroll.build, extensionId: installed.id, scroll, privateWindow: true,
  personalDataUsed: false, liveRealSiteAccuracy: false,
  screenshotEnabled: !domOnly,
  syntheticClickVerified: privacyClick ? true : undefined,
  syntheticSearchVerified: search ? true : undefined }, null, 2));
