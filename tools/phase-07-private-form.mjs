// Original master-plan Phase 7 acceptance: real extension local secure input
// on a synthetic private form. No personal profile/account/credential and no
// planner request contains the synthetic secret.
import assert from 'node:assert/strict';
import { cdp, debugJson, evaluate, extensionPath, findSession } from './reload-in-place.mjs';

const fixtureUrl = 'http://127.0.0.1:4317/benchmark.html?case=login-form';
const syntheticSecret = 'Synthetic-Local-Only-9274!';
// Opt-in, fixed-enum stage tracing only. No field values or browser content.
const mark = stage => { if (process.env.CAPTAIN_ACCEPTANCE_STAGE === '1')
  console.error('SAFE_STAGE:' + stage); };
// A user-like gesture must enable focus emulation and keep mouse press/release
// in the SAME CDP session. Without focus emulation a background fixture may
// accept Input.insertText but drop all mouse events. Never use element.click()
// as an acceptance shortcut: it is not a delivered browser input gesture.
function cdpGesture(url, commands) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    let next = 0, settled = false;
    const timer = setTimeout(() => finish(new Error('Local input gesture timed out.')), 10000);
    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      error ? reject(error) : resolve();
    }
    function sendNext() {
      if (next >= commands.length) return finish();
      const [method, params] = commands[next];
      socket.send(JSON.stringify({ id: next + 1, method, params }));
    }
    socket.onopen = sendNext;
    socket.onerror = () => finish(new Error('Local input gesture connection failed.'));
    socket.onclose = () => finish(new Error('Local input gesture connection closed.'));
    socket.onmessage = event => {
      let message;
      try { message = JSON.parse(event.data); }
      catch { return finish(new Error('Malformed local input gesture response.')); }
      if (message.id !== next + 1) return;
      if (message.error) return finish(new Error('Local input gesture rejected.'));
      next++;
      sendNext();
    };
  });
}
// Inspect only boolean state of a CDP-resolved node. Never return the value,
// source text, HTML, or properties that could contain the synthetic secret.
function cdpInputState(url, backendNodeId) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    let settled = false;
    const timer = setTimeout(() => finish(new Error('Local input state timed out.')), 10000);
    function finish(error, state) {
      if (settled) return;
      settled = true; clearTimeout(timer); socket.close();
      error ? reject(error) : resolve(state);
    }
    socket.onopen = () => socket.send(JSON.stringify({id:1,method:'DOM.resolveNode',params:{backendNodeId}}));
    socket.onerror = () => finish(new Error('Local state connection failed.'));
    socket.onclose = () => finish(new Error('Local state connection closed.'));
    socket.onmessage = event => {
      let message;
      try { message=JSON.parse(event.data); } catch { return finish(new Error('Malformed state response.')); }
      if (message.error) return finish(new Error('Local state request rejected.'));
      if (message.id===1) {
        const objectId=message.result?.object?.objectId;
        if (!objectId) return finish(new Error('Local state target unavailable.'));
        socket.send(JSON.stringify({id:2,method:'Runtime.callFunctionOn',params:{objectId,
          functionDeclaration:'function(){return {nonempty:!!this.value,focused:this.getRootNode().activeElement===this,connected:this.isConnected}}',returnByValue:true}}));
      } else if (message.id===2) {
        const state=message.result?.result?.value;
        if (!state || !['nonempty','focused','connected'].every(k=>typeof state[k]==='boolean'))
          return finish(new Error('Local state shape unavailable.'));
        finish(null,state);
      }
    };
  });
}
mark('BEGIN');
const browser = await debugJson('/json/version');
mark('BROWSER_DEBUG_READY');
const { extensions = [] } = await cdp(browser.webSocketDebuggerUrl, 'Extensions.getExtensions');
mark('EXTENSIONS_DISCOVERED');
const installed = extensions.find(item => item.path?.toLowerCase() === extensionPath.toLowerCase());
assert.ok(installed?.id, 'The exact workspace extension must be loaded.');
const session = await findSession(installed.id);
mark('SESSION_DISCOVERED');
assert.ok(session?.controller?.webSocketDebuggerUrl && session.windowId,
  'Run npm run demo first; a disposable private CAPTAIN controller is required.');

let fixture = await evaluate(session.controller,
  'chrome.tabs.query({windowId:' + session.windowId + '}).then(tabs=>tabs.find(tab=>tab.url===' +
  JSON.stringify(fixtureUrl) + ')||null)');
mark('FIXTURE_LOOKUP');
if (fixture) {
  // Only this exact synthetic fixture may be reset. An old completed tab can
  // become unresponsive while preserving its URL, so document readiness must
  // come from a fresh load, never a stale panel or a personal page.
  const reset = await evaluate(session.controller, '(async()=>{' +
    'const t=await chrome.tabs.get(' + fixture.id + ');' +
    'if(!t.incognito||t.windowId!==' + session.windowId + '||t.url!==' +
    JSON.stringify(fixtureUrl) + ')return false;' +
    'await chrome.tabs.reload(t.id);return true;})()', 5000);
  assert.equal(reset, true, 'Only the exact synthetic private fixture can be reloaded.');
  mark('EXACT_FIXTURE_RESET');
} else fixture = await evaluate(session.controller,
  'chrome.tabs.create({windowId:' + session.windowId + ',url:' + JSON.stringify(fixtureUrl) + ',active:true})');
mark('FIXTURE_CREATED_OR_REUSED');
assert.equal(fixture.incognito, true);
await evaluate(session.controller, 'chrome.tabs.update(' + fixture.id + ',{active:true})');
mark('FIXTURE_ACTIVE');
// An active tab in a minimized/occluded private window can remain hidden;
// DevTools can focus its input but synthetic mouse/keyboard confirmation does
// not activate. Restore/focus ONLY the independently verified CAPTAIN window.
const privateWindowState=await evaluate(session.controller,
  '(async()=>{const w=await chrome.windows.get('+session.windowId+');return {incognito:w.incognito,state:w.state,focused:w.focused};})()');
assert.equal(privateWindowState?.incognito,true,'The CAPTAIN window is no longer private.');
mark(privateWindowState.state==='minimized'?'PRIVATE_WINDOW_MINIMIZED':'PRIVATE_WINDOW_NOT_MINIMIZED');
await evaluate(session.controller,'chrome.windows.update('+session.windowId+', {state:"normal",focused:true}).then(w=>({incognito:w.incognito,focused:w.focused,state:w.state}))');
mark('PRIVATE_WINDOW_RESTORED_AND_FOCUSED');

let ready = false;
for (let attempt = 0; attempt < 40; attempt++) {
  try {
    ready = await evaluate(session.controller,
      '(async()=>{const tab=await chrome.tabs.get(' + fixture.id + ');' +
      'if(tab.status!=="complete"||tab.url!==' + JSON.stringify(fixtureUrl) + ')return false;' +
      'try{const r=await chrome.tabs.sendMessage(tab.id,{type:"READINESS"});return !!r?.ready;}catch{return false;}})()');
    if (ready) break;
  } catch {}
  await new Promise(resolve => setTimeout(resolve, 150));
}
assert.equal(ready, true, 'Synthetic private form did not become observable.');
mark('FORM_READY');

const targets = await debugJson('/json/list');
const worker = targets.find(item => item.type === 'service_worker' &&
  item.url === 'chrome-extension://' + installed.id + '/action-binding-entry.js');
assert.ok(worker?.webSocketDebuggerUrl, 'Private CAPTAIN service worker is unavailable.');

const firstObservation = await evaluate(session.controller,
  'chrome.tabs.sendMessage(' + fixture.id + ',{type:"OBSERVE"})');
const email = firstObservation?.elements?.find(element => element.sensitiveType === 'email');
const password = firstObservation?.elements?.find(element =>
  element.sensitive === true && element.sensitiveType === 'password');
assert.ok(email?.ref && email.sensitive === true, 'Synthetic email field must be protected.');
assert.match(email.name, /\[EMAIL_1\]/, 'Email placeholder must be typed, not a raw value.');
assert.match(password?.name || '', /\[PASSWORD_1\]/, 'Password placeholder must be typed.');
assert.doesNotMatch(JSON.stringify(firstObservation), /judge@example\.com|NeverSendThis/,
  'Original synthetic form values cannot leave the page observation.');
assert.ok(password?.ref && firstObservation?.pageMetadata?.documentToken &&
  firstObservation?.pageMetadata?.observationId, 'Password field was not observed with a fresh local lease.');
mark('FIRST_OBSERVATION');

// The packaged privileged binding gate must accept a valueless local prompt
// and reject the same target when a remote value is attached.
const gateInput = JSON.stringify({
  ref: password.ref, element: password, url: firstObservation.url,
  documentGeneration: firstObservation.pageMetadata.documentToken
});
const gateResult = await evaluate(worker, '(input=>{const x=' + gateInput + ';' +
  'const base={tabId:' + fixture.id + ',windowId:' + session.windowId + ',frameId:0,' +
  'url:x.url,origin:new URL(x.url).origin,documentGeneration:x.documentGeneration,' +
  'observationId:"phase7-secure-binding",createdMonotonicMs:performance.now(),navigationEpoch:1,ttlMs:120000,active:true};' +
  'const fresh={...base,elements:[x.element]};let localAccepted=false,remoteBlocked=false;' +
  'try{CAPTAIN_ACTION_BINDING.validateActionOnDevice({action:{type:"request_local_input",target:{ref:x.ref},inputType:"password"}},fresh,{...base,nowMonotonicMs:performance.now()});localAccepted=true;}catch{}' +
  'try{CAPTAIN_ACTION_BINDING.validateActionOnDevice({action:{type:"type",target:{ref:x.ref},value:' +
    JSON.stringify(syntheticSecret) + '}},fresh,{...base,nowMonotonicMs:performance.now()});}catch{remoteBlocked=true;}' +
  'return {localAccepted,remoteBlocked};})()');
assert.equal(gateResult.localAccepted, true, 'Packaged device gate rejected local secure input.');
assert.equal(gateResult.remoteBlocked, true, 'Packaged device gate allowed a remote sensitive value.');
mark('BINDING_GATE');

// The page executor has a second independent sensitive-field block.
const firstGuard = firstObservation.pageMetadata;
const remoteResult = await evaluate(session.controller,
  'chrome.tabs.sendMessage(' + fixture.id + ',{type:"EXECUTE",action:{type:"type",target:{ref:' +
  JSON.stringify(password.ref) + '},value:' + JSON.stringify(syntheticSecret) + '},observationGuard:' +
  JSON.stringify({
    documentToken: firstGuard.documentToken,
    observationId: firstGuard.observationId,
    domRevision: firstGuard.domRevision,
    geometryRevision: firstGuard.geometryRevision
  }) + '})');
assert.equal(remoteResult?.ok, false);
assert.match(remoteResult?.error || '', /sensitive field|secure input/i);
mark('REMOTE_WRITE_DENIED');

// Re-observe after the one-use execution guard, then open the actual closed
// shadow local prompt. Keep its pending result only inside the controller.
const localObservation = await evaluate(session.controller,
  'chrome.tabs.sendMessage(' + fixture.id + ',{type:"OBSERVE"})');
const localPassword = localObservation?.elements?.find(element =>
  element.sensitive === true && element.sensitiveType === 'password');
assert.ok(localPassword?.ref);
const localGuard = localObservation.pageMetadata;
const prepared = await evaluate(session.controller,
  '(()=>{globalThis.__captainSecureOutcome=null;const pending=chrome.tabs.sendMessage(' + fixture.id +
  ',{type:"EXECUTE",action:{type:"request_local_input",target:{ref:' + JSON.stringify(localPassword.ref) +
  '},inputType:"password"},observationGuard:' + JSON.stringify({
    documentToken: localGuard.documentToken,
    observationId: localGuard.observationId,
    domRevision: localGuard.domRevision,
    geometryRevision: localGuard.geometryRevision
  }) + '});globalThis.__captainSecureAcceptance=pending;' +
  'pending.then(result=>{if(globalThis.__captainSecureAcceptance===pending)' +
  'globalThis.__captainSecureOutcome={ok:result?.ok===true,localOnly:result?.localOnly===true,' +
  'hasValue:Object.hasOwn(result??{},"value")};},()=>{' +
  'if(globalThis.__captainSecureAcceptance===pending)' +
  'globalThis.__captainSecureOutcome={ok:false,localOnly:false,hasValue:false};});' +
  'return {ok:true};})()');
assert.equal(prepared?.ok, true);
mark('LOCAL_PROMPT_REQUESTED');

// Closed-shadow prompt: CDP keyboard input acts as the local user while the
// prompt's secure input is focused. Chrome's accessibility tree can see the
// real Insert locally button even though page JS cannot pierce the shadow root.
// No production testing hook is added.
let page;
for (let attempt = 0; attempt < 30; attempt++) {
  // Several historical synthetic tabs can share the exact fixture URL. A
  // URL-only /json/list lookup may type/click in a *different* tab than the
  // tab whose EXECUTE promise is pending. Bind its CDP target to the actual
  // browser tab ID before local-only input, without touching any other tab.
  const exactTargetId = await evaluate(session.controller,
    'chrome.debugger.getTargets().then(items=>items.find(item=>item.tabId===' + fixture.id +
    '&&item.url===' + JSON.stringify(fixtureUrl) + ')?.id||null)');
  page = (await debugJson('/json/list')).find(item =>
    item.id === exactTargetId && item.type === 'page' &&
    item.url === fixtureUrl && item.webSocketDebuggerUrl);
  if (page) break;
  await new Promise(resolve => setTimeout(resolve, 100));
}
assert.ok(page?.webSocketDebuggerUrl);
mark('EXACT_FIXTURE_DEBUG_TARGET_BOUND');
// DevTools may keep the synthetic fixture as a background target even when the
// extension-side tab is marked active. Bring this exact verified fixture to the
// front before emulating local input; never activate an arbitrary user tab.
await cdp(page.webSocketDebuggerUrl, 'Page.bringToFront');
mark('EXACT_FIXTURE_BROUGHT_TO_FRONT');
const focusState=await evaluate(page,'({focused:document.hasFocus(),visible:document.visibilityState==="visible"})');
mark(focusState?.focused ? 'FIXTURE_DOCUMENT_FOCUSED' : 'FIXTURE_DOCUMENT_NOT_FOCUSED');
mark(focusState?.visible ? 'FIXTURE_DOCUMENT_VISIBLE' : 'FIXTURE_DOCUMENT_NOT_VISIBLE');
// Keep only event counts in the synthetic fixture for debugger diagnosis.
await evaluate(page,'(()=>{const counts=Object.create(null);for(const kind of ["pointerdown","mousedown","mouseup","click","keydown","keyup","submit"]){counts[kind]=0;document.addEventListener(kind,()=>{counts[kind]++},{capture:true});}globalThis.__captainSyntheticEventCounts=counts;return true;})()');
await new Promise(resolve => setTimeout(resolve, 250));
// A reattached CDP page session does not guarantee that the previously focused
// closed-shadow input is still the keyboard target. Resolve its accessibility
// node and focus the actual private prompt before injecting synthetic test text.
// Never inspect or return its value: only the user-local browser receives it.
const secureAx = await cdp(page.webSocketDebuggerUrl, 'Accessibility.getFullAXTree');
const secureField = secureAx.nodes.find(node =>
  node.name?.value === 'Local secure value' && node.backendDOMNodeId);
assert.ok(secureField?.backendDOMNodeId, 'Local secure input is unavailable.');
const confirm = secureAx.nodes.find(node =>
  node.role?.value === 'button' && node.name?.value === 'Insert locally');
assert.ok(confirm?.backendDOMNodeId, 'Local secure confirmation button is unavailable.');
await cdp(page.webSocketDebuggerUrl, 'DOM.focus',
  { backendNodeId: secureField.backendDOMNodeId });
mark('LOCAL_SECURE_INPUT_FOCUSED');
await cdp(page.webSocketDebuggerUrl, 'Input.insertText', { text: syntheticSecret });
mark('SYNTHETIC_LOCAL_KEYBOARD');
const typedState=await cdpInputState(page.webSocketDebuggerUrl,secureField.backendDOMNodeId);
mark(typedState.nonempty ? 'LOCAL_INPUT_DOM_NONEMPTY':'LOCAL_INPUT_DOM_EMPTY');
mark(typedState.focused ? 'LOCAL_INPUT_DOM_FOCUSED':'LOCAL_INPUT_DOM_NOT_FOCUSED');
assert.equal(typedState.nonempty && typedState.focused && typedState.connected,true,
  'Only a focused nonempty local secure input may be confirmed.');
mark('LOCAL_CONFIRM_BUTTON');
const box = await cdp(page.webSocketDebuggerUrl, 'DOM.getBoxModel', { backendNodeId: confirm.backendDOMNodeId });
const quad = box.model.content;
const clickX = (quad[0] + quad[2] + quad[4] + quad[6]) / 4;
const clickY = (quad[1] + quad[3] + quad[5] + quad[7]) / 4;
const hit = await cdp(page.webSocketDebuggerUrl, 'DOM.getNodeForLocation',
  { x: Math.round(clickX), y: Math.round(clickY), includeUserAgentShadowDOM: true });
const hitNode = await cdp(page.webSocketDebuggerUrl, 'DOM.describeNode',
  { backendNodeId: hit.backendNodeId });
mark(hitNode.node?.nodeName === 'BUTTON' ? 'CONFIRM_COORDINATE_HITS_BUTTON' :
  'CONFIRM_COORDINATE_MISSES_BUTTON');
mark(hit.backendNodeId === confirm.backendDOMNodeId ? 'CONFIRM_HIT_EXACT' : 'CONFIRM_HIT_ANOTHER_BUTTON');
assert.equal(hit.backendNodeId, confirm.backendDOMNodeId,
  'The exact local confirmation control must own the click position.');
await cdpGesture(page.webSocketDebuggerUrl, [
  ['Emulation.setFocusEmulationEnabled', {enabled:true}],
  ['Input.dispatchMouseEvent', { type: 'mousePressed', x: clickX, y: clickY,
    button: 'left', clickCount: 1 }],
  ['Input.dispatchMouseEvent', { type: 'mouseReleased', x: clickX, y: clickY,
    button: 'left', clickCount: 1 }]
]);
mark('LOCAL_BUTTON_CLICKED');
const gestureCounts=await evaluate(page,'(()=>{const x=globalThis.__captainSyntheticEventCounts||{};return {down:Number(x.mousedown)||0,up:Number(x.mouseup)||0,click:Number(x.click)||0,submit:Number(x.submit)||0};})()');
mark(gestureCounts.down&&gestureCounts.up?'CDP_MOUSE_EVENTS_DELIVERED':'CDP_MOUSE_EVENTS_NOT_DELIVERED');
mark(gestureCounts.click?'CDP_CLICK_EVENT_DELIVERED':'CDP_CLICK_EVENT_NOT_DELIVERED');
mark(gestureCounts.submit?'CDP_SUBMIT_EVENT_DELIVERED':'CDP_SUBMIT_EVENT_NOT_DELIVERED');
assert.ok(gestureCounts.down && gestureCounts.up && gestureCounts.click,
  'The focused synthetic input gesture did not reach the actual browser page.');
const insertedImmediately = await evaluate(page,
  'document.querySelector("input[type=password]")?.value === ' + JSON.stringify(syntheticSecret));
mark(insertedImmediately ? 'VALUE_AFTER_CLICK_TRUE' : 'VALUE_AFTER_CLICK_FALSE');
assert.equal(insertedImmediately, true, 'The local gesture did not insert the synthetic value.');

// Poll only fixed boolean outcome fields. A background Incognito controller
// can throttle its own setTimeout, so timeout policy belongs to the external
// Node harness, not a timer on the hidden extension page.
let completion;
for (let attempt = 0; attempt < 20; attempt++) {
  try {
    completion = await evaluate(session.controller,
      '(()=>{const x=globalThis.__captainSecureOutcome;if(!x)return null;' +
      'delete globalThis.__captainSecureOutcome;delete globalThis.__captainSecureAcceptance;' +
      'return x;})()', 2500);
    if (completion) break;
  } catch { /* Actual page/controller errors still fail the bounded gate. */ }
  await new Promise(resolve => setTimeout(resolve, 250));
}
mark(completion ? 'OUTCOME_RECEIVED' : 'OUTCOME_ABSENT');
assert.equal(completion?.ok, true, 'Local secure-input action did not complete.');
mark('LOCAL_ACTION_COMPLETED');
assert.equal(completion.localOnly, true);
assert.equal(completion.hasValue, false, 'Secure result must never return the credential.');

const inserted = await evaluate(page,
  'document.querySelector("input[type=password]")?.value === ' + JSON.stringify(syntheticSecret));
assert.equal(inserted, true, 'Synthetic local value was not inserted into the intended password field.');
mark('LOCAL_VALUE_VERIFIED');

const after = await evaluate(session.controller,
  'chrome.tabs.sendMessage(' + fixture.id + ',{type:"OBSERVE"}).then(o=>({' +
  'hasRaw:JSON.stringify(o).includes(' + JSON.stringify(syntheticSecret) + '),' +
  'sensitive:(o.elements||[]).filter(e=>e.sensitive).map(e=>({ref:e.ref,type:e.sensitiveType,value:e.value||""}))}))');
assert.equal(after.hasRaw, false);
assert.ok(after.sensitive.some(item => item.type === 'password'));
assert.ok(after.sensitive.every(item => !String(item.value).includes('Synthetic-Local-Only')));
mark('POST_INSERT_OBSERVATION');

const unauthorized = await fetch('http://127.0.0.1:4317/api/agent/step', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ task: 'synthetic check', context: { url: fixtureUrl, title: 'fixture', elements: [] }, history: [] })
});
assert.equal(unauthorized.status, 401);

console.log(JSON.stringify({
  scope: 'real extension local secure input on synthetic private form',
  privateWindow: true,
  syntheticOnly: true,
  sensitiveType: 'password',
  typedEmailPlaceholderVerified: true,
  typedPasswordPlaceholderVerified: true,
  remoteSensitiveWriteBlocked: true,
  localInsertionVerified: true,
  actionResultLocalOnly: completion.localOnly === true,
  credentialReturnedByAction: false,
  credentialPresentInObservation: false,
  unauthenticatedCompanionRejected: true,
  personalDataUsed: false
}, null, 2));
