import assert from 'node:assert/strict';
import { cdp, debugJson, evaluate, extensionPath, findSession } from './reload-in-place.mjs';

const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const command = process.argv.slice(2).filter(value => !value.startsWith('--')).join(' ') || 'open github.com/login';
const continuePrivacy = process.argv.includes('--continue');
const stopPrivacy = process.argv.includes('--stop');
const cancelTask = process.argv.includes('--cancel');
const usePagePanel = process.argv.includes('--panel');
assert.ok([continuePrivacy, stopPrivacy, cancelTask].filter(Boolean).length <= 1, 'Choose only one of --continue, --stop, or --cancel.');
const version = await debugJson('/json/version');
const installed = await cdp(version.webSocketDebuggerUrl, 'Extensions.getExtensions');
const extension = installed.extensions.find(item => item.path?.toLowerCase() === extensionPath.toLowerCase());
assert.ok(extension, 'Start CAPTAIN first.');
const session = await findSession(extension.id);
assert.ok(session?.controller, 'Normal CAPTAIN controller unavailable.');
const readState = () => evaluate(session.controller, "chrome.runtime.sendMessage({type:'GET_STATE'})");
const initial = await readState();

if (cancelTask) {
  const result = await evaluate(session.controller, "chrome.runtime.sendMessage({type:'CANCEL_TASK'})");
  assert.equal(result?.ok, true, 'CAPTAIN task could not be cancelled.');
  console.log(JSON.stringify({ step: 'task-cancelled' }));
} else if (continuePrivacy || stopPrivacy) {
  assert.equal(initial.status, 'waiting_privacy_consent', 'CAPTAIN is not waiting for privacy consent.');
  const target = await evaluate(session.controller, `chrome.tabs.get(${initial.session?.tabId}).then(tab=>({id:tab.id,windowId:tab.windowId}))`);
  const pageTargetId = await evaluate(session.controller,
    `(async()=>chrome.debugger.getTargets().then(items=>items.find(item=>item.tabId===${target.id})?.id||''))()`);
  const page = (await debugJson('/json/list')).find(item => item.id === pageTargetId);
  assert.ok(page, 'Live page debugger target unavailable.');
  await evaluate(session.controller, `chrome.tabs.update(${target.id},{active:true})`);
  const expand = await evaluate(page, `(()=>{const r=document.querySelector('#captain-agent-host')?.shadowRoot;if(!r?.querySelector('.card').classList.contains('collapsed'))return null;const b=r.querySelector('.collapse').getBoundingClientRect();return {x:b.x+b.width/2,y:b.y+b.height/2}})()`);
  if (expand) {
    await cdp(page.webSocketDebuggerUrl, 'Input.dispatchMouseEvent', {type:'mousePressed',...expand,button:'left',buttons:1,clickCount:1});
    await cdp(page.webSocketDebuggerUrl, 'Input.dispatchMouseEvent', {type:'mouseReleased',...expand,button:'left',buttons:0,clickCount:1});
  }
  const selector = stopPrivacy ? '.consent-stop' : '.consent-continue';
  const point = await evaluate(page,
    `(()=>{const button=document.querySelector('#captain-agent-host')?.shadowRoot?.querySelector(${JSON.stringify(selector)});if(!button||button.hidden)return null;button.scrollIntoView({block:'nearest',behavior:'instant'});const rect=button.getBoundingClientRect();if(!rect.width||!rect.height)return null;return {x:rect.x+rect.width/2,y:rect.y+rect.height/2};})()`);
  assert.ok(point, `${stopPrivacy ? 'Stop' : 'Continue'} button is not visible.`);
  await cdp(page.webSocketDebuggerUrl, 'Emulation.setFocusEmulationEnabled', { enabled: true });
  await cdp(page.webSocketDebuggerUrl, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
  await cdp(page.webSocketDebuggerUrl, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1 });
  await cdp(page.webSocketDebuggerUrl, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1 });
  console.log(JSON.stringify({ step: stopPrivacy ? 'stopped-without-sharing' : 'continued-without-sharing', targetTab: target.id }));
} else {
  assert.ok(!['running', 'waiting_privacy_consent', 'waiting_human'].includes(initial.status), 'Finish or cancel the active CAPTAIN task first.');
  const inputTarget = usePagePanel ? await (async () => {
    assert.ok(initial.session?.tabId, 'No active CAPTAIN page panel.');
    const pageTargetId = await evaluate(session.controller,
      `(async()=>chrome.debugger.getTargets().then(items=>items.find(item=>item.tabId===${initial.session.tabId})?.id||''))()`);
    const page = (await debugJson('/json/list')).find(item => item.id === pageTargetId);
    assert.ok(page, 'Live page debugger target unavailable.');
    const visible = await evaluate(page,
      "(()=>{const host=document.querySelector('#captain-agent-host');const input=host?.shadowRoot?.querySelector('.task');return !!input&&getComputedStyle(host).display!=='none';})()");
    assert.ok(visible, 'Hold E for four seconds to open the page panel first.');
    return { socket: page.webSocketDebuggerUrl, expression: "(()=>{const input=document.querySelector('#captain-agent-host').shadowRoot.querySelector('.task');input.value='';input.focus();return true;})()" };
  })() : await (async () => {
    await evaluate(session.controller,
      `(async()=>{const tab=await chrome.tabs.getCurrent();await chrome.tabs.update(tab.id,{active:true});await chrome.windows.update(tab.windowId,{focused:true});return true;})()`);
    return { socket: session.controller.webSocketDebuggerUrl, expression: "(()=>{const input=document.querySelector('#task');input.value='';input.focus();return true;})()" };
  })();
  await cdp(inputTarget.socket, 'Runtime.evaluate', {
    expression: inputTarget.expression,
    userGesture: true,
  });
  for (const character of command) {
    await cdp(inputTarget.socket, 'Input.insertText', { text: character });
    await pause(35);
  }
  await cdp(inputTarget.socket, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await cdp(inputTarget.socket, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  console.log(JSON.stringify({ step: usePagePanel ? 'page-panel-command-submitted' : 'text-command-submitted', command }));
}

const deadline = Date.now() + 60_000;
let state;
while (Date.now() < deadline) {
  state = await readState();
  if ((continuePrivacy || stopPrivacy || cancelTask) ? ['complete', 'error', 'waiting_human'].includes(state.status) :
    ['waiting_privacy_consent', 'complete', 'error', 'waiting_human'].includes(state.status)) break;
  await pause(250);
}
assert.ok(state, 'CAPTAIN did not return task state.');
console.log(JSON.stringify({
  step: (continuePrivacy || stopPrivacy || cancelTask) ? 'post-consent-state' : 'pre-consent-state',
  status: state.status,
  phase: state.phase,
  piiDetected: state.piiDetected,
  message: state.message,
  completionStatus: state.completionStatus,
  targetTab: state.session?.tabId,
}));
