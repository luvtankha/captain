// Read-only inventory of CAPTAIN's disposable Incognito window.
// Never navigates, closes, captures, or modifies a tab.
import assert from 'node:assert/strict';
import { cdp, debugJson, evaluate, extensionPath, findSession } from './reload-in-place.mjs';
const browser = await debugJson('/json/version');
const { extensions = [] } = await cdp(browser.webSocketDebuggerUrl, 'Extensions.getExtensions');
const installed = extensions.find(item => item.path?.toLowerCase() === extensionPath.toLowerCase());
assert.ok(installed?.id, 'CAPTAIN workspace extension is not installed.');
const session = await findSession(installed.id);
assert.ok(session?.windowId && session.controller, 'No CAPTAIN private controller.');
const tabs = await evaluate(session.controller,
  `chrome.tabs.query({windowId:${session.windowId}}).then(tabs=>tabs.map(tab=>({
    id:tab.id,incognito:tab.incognito,active:tab.active,url:tab.url
  })))`);
const task = await evaluate(session.controller, `chrome.runtime.sendMessage({type:'GET_STATE'}).then(s=>({
  status:s.status,phase:s.phase,step:s.step,completionStatus:s.completionStatus,
  message:typeof s.message==='string'?s.message.slice(0,160):null,
  timeline:(s.timeline||[]).slice(-8).map(t=>({type:t.type,step:t.step,latencyMs:t.latencyMs})),
  actions:(s.history||[]).map(h=>h.action?.type).filter(Boolean)
}))`);
console.log(JSON.stringify({task},null,2));
console.log(JSON.stringify(tabs.map(tab => {
  const url = new URL(tab.url);
  return { id: tab.id, incognito: tab.incognito, active: tab.active,
    origin: url.origin, path: url.pathname,
    // Do not emit user query/fragment; these are synthetic-only test tabs.
    queryPresent: Boolean(url.search),
    queryKeys: url.hostname === '127.0.0.1' ? [...url.searchParams.keys()] : [],
    syntheticQueryLength: url.hostname === '127.0.0.1' ? (url.searchParams.get('q') || '').length : undefined,
    extensionOwned: url.hostname === installed.id };
}), null, 2));
