// Original master-plan Phase 7: cancel one synthetic task before its first
// action. Never touch unrelated tabs, personal profiles or real credentials.
import assert from 'node:assert/strict';
import { cdp, debugJson, evaluate, extensionPath, findSession } from './reload-in-place.mjs';

const fixtureUrl = 'http://127.0.0.1:4317/privacy-fixture.html';
const allowed = new Set([
  fixtureUrl, 'http://127.0.0.1:4317/demo.html',
  'http://127.0.0.1:4317/demo.html?q=laptop',
  'http://127.0.0.1:4317/benchmark.html?case=login-form'
]);
const browser = await debugJson('/json/version');
const { extensions = [] } = await cdp(browser.webSocketDebuggerUrl, 'Extensions.getExtensions');
const installed = extensions.find(item => item.path?.toLowerCase() === extensionPath.toLowerCase());
assert.ok(installed?.id, 'The exact workspace extension must be installed.');
const session = await findSession(installed.id);
assert.ok(session?.windowId && session.controller, 'CAPTAIN private controller missing.');
const tabs = await evaluate(session.controller, `chrome.tabs.query({windowId:${session.windowId}}).then(t=>
  t.map(x=>({id:x.id,incognito:x.incognito,url:x.url})))`);
assert.ok(tabs.every(tab => tab.incognito && (allowed.has(tab.url) ||
  tab.url?.startsWith(`chrome-extension://${installed.id}/`))),
  'An unexpected tab is open; no test command was sent.');

let fixture = tabs.find(tab => tab.url === fixtureUrl);
if (!fixture) fixture = await evaluate(session.controller,
  `chrome.tabs.create({windowId:${session.windowId},url:${JSON.stringify(fixtureUrl)},active:true})`);
await evaluate(session.controller, `chrome.tabs.update(${fixture.id},{active:true})`);
let ready = false;
for (let i = 0; i < 40; i++) {
  try {
    ready = await evaluate(session.controller, `(async()=>{
      const tab=await chrome.tabs.get(${fixture.id});
      if(!tab.incognito||tab.windowId!==${session.windowId}||tab.status!=='complete'||
         tab.url!==${JSON.stringify(fixtureUrl)})return false;
      return !!(await chrome.tabs.sendMessage(tab.id,{type:'READINESS'}))?.ready;
    })()`);
    if (ready) break;
  } catch {}
  await new Promise(resolve => setTimeout(resolve, 150));
}
assert.equal(ready, true, 'Synthetic page did not become ready.');
const page = (await debugJson('/json/list')).find(item =>
  item.type === 'page' && item.url === fixtureUrl && item.webSocketDebuggerUrl);
assert.ok(page, 'Synthetic page target unavailable.');
assert.equal(await evaluate(page, `(()=>{
  const button=document.querySelector('[data-captain-ui="details"]');
  if(!button||button.textContent.trim()!=='View laptop details')return false;
  globalThis.__captainCancelClicks=0;
  button.addEventListener('click',()=>globalThis.__captainCancelClicks++);
  return true;
})()`), true);
const accepted = await evaluate(session.controller,
  `chrome.runtime.sendMessage({type:'START_TASK',task:'click View laptop details',tabId:${fixture.id}})`);
assert.equal(accepted?.ok, true, 'Synthetic task was not accepted.');
const cancel = await evaluate(session.controller, `chrome.runtime.sendMessage({type:'CANCEL_TASK'})`);
assert.equal(cancel?.ok, true);
let state;
for (let i = 0; i < 100; i++) {
  state = await evaluate(session.controller,
    `chrome.runtime.sendMessage({type:'GET_STATE'}).then(s=>({
      status:s.status,phase:s.phase,completionStatus:s.completionStatus,
      actions:(s.history||[]).map(x=>x.action?.type).filter(Boolean)
    }))`);
  if (state?.status === 'error' && state.phase === 'Cancelled') break;
  await new Promise(resolve => setTimeout(resolve, 100));
}
assert.equal(state?.status, 'error', 'Cancelled task did not settle.');
assert.equal(state.phase, 'Cancelled');
assert.equal(state.completionStatus, 'FAILED');
assert.deepEqual(state.actions, [], 'An action was sent after cancellation.');
assert.equal(await evaluate(page, 'globalThis.__captainCancelClicks'), 0,
  'The synthetic public control was clicked after cancellation.');
console.log(JSON.stringify({
  scope: 'real disposable extension cancel before first action',
  cancellationSettled: true, executedActions: 0, syntheticClicks: 0,
  privateWindow: true, personalDataUsed: false
}, null, 2));
