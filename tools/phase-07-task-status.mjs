// Read-only metadata status in the dedicated CAPTAIN private browser.
import assert from 'node:assert/strict';
import { cdp, debugJson, evaluate, extensionPath, findSession } from './reload-in-place.mjs';
const browser = await debugJson('/json/version');
const { extensions = [] } = await cdp(browser.webSocketDebuggerUrl, 'Extensions.getExtensions');
const installed = extensions.find(item => item.path?.toLowerCase() === extensionPath.toLowerCase());
assert.ok(installed?.id);
const session = await findSession(installed.id);
assert.ok(session?.controller);
const state = await evaluate(session.controller, `chrome.runtime.sendMessage({type:'GET_STATE'}).then(s=>({
  status:s.status,phase:s.phase,step:s.step,completionStatus:s.completionStatus,
  outcomeVerified:s.outcomeVerified,actions:(s.history||[]).map(h=>h.action?.type).filter(Boolean),
  message:typeof s.message==='string'?s.message.slice(0,180):null
}))`);
console.log(JSON.stringify(state,null,2));
