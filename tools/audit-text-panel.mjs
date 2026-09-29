import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { cdp, debugJson, evaluate, extensionPath, findSession } from './reload-in-place.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const version = await debugJson('/json/version');
const installed = await cdp(version.webSocketDebuggerUrl, 'Extensions.getExtensions');
const extension = installed.extensions.find(item => item.path?.toLowerCase() === extensionPath.toLowerCase());
assert.ok(extension, 'Start CAPTAIN first.');
const session = await findSession(extension.id);
assert.ok(session?.controller, 'Normal controller unavailable.');
const state = await evaluate(session.controller, "chrome.runtime.sendMessage({type:'GET_STATE'})");
assert.ok(!['running', 'waiting_privacy_consent', 'waiting_human'].includes(state.status), 'Finish the active command first.');
// Use only the dedicated public test tab, without submitting any page data.
const targetId = state.session?.tabId;
assert.ok(targetId, 'Run a public navigation audit first.');
await evaluate(session.controller, `chrome.tabs.update(${targetId}, {url:'https://example.com/',active:true})`);
let page;
for (let n = 0; n < 100; n++) {
  page = (await debugJson('/json/list')).find(t => t.type === 'page' && t.url === 'https://example.com/');
  if (page && await evaluate(page, "!!document.querySelector('#captain-agent-host')").catch(() => false)) break;
  await pause(100);
}
assert.ok(page, 'Public page unavailable.');
const snapshot = () => evaluate(page, `(()=>{const h=document.querySelector('#captain-agent-host'),r=h.getBoundingClientRect();return {display:getComputedStyle(h).display,x:r.x,y:r.y,width:r.width,height:r.height,focused:h.shadowRoot.activeElement?.className||'',buttons:[...h.shadowRoot.querySelectorAll('button')].map(b=>b.textContent)}})()`);
const key = type => cdp(page.webSocketDebuggerUrl, 'Input.dispatchKeyEvent', {type,key:'e',code:'KeyE',windowsVirtualKeyCode:69});
await cdp(page.webSocketDebuggerUrl, 'Emulation.setFocusEmulationEnabled', {enabled:true});
assert.equal((await snapshot()).display, 'none', 'Idle panel must start hidden.');
await key('rawKeyDown'); await pause(1000); await key('keyUp');
await pause(3200);
assert.equal((await snapshot()).display, 'none', 'Releasing early must cancel activation.');
await key('rawKeyDown'); await pause(3500);
assert.equal((await snapshot()).display, 'none', 'Must wait the full four seconds.');
await pause(650); await key('keyUp');
for (let n = 0; n < 100; n++) {
  if (await evaluate(page, "(()=>{const r=document.querySelector('#captain-agent-host')?.shadowRoot,c=r?.querySelector('.preview-canvas');return !!c&&!c.hidden&&c.width>300})()")) break;
  await pause(100);
}
const opened = await snapshot();
assert.equal(opened.display, 'block'); assert.equal(opened.x, 8); assert.equal(opened.y, 8);
assert.equal(opened.width, 366); assert.equal(opened.focused, 'task');
assert.ok(opened.height < 640);
assert.match(await evaluate(page,"document.querySelector('#captain-agent-host').shadowRoot.querySelector('.preview-note').textContent"),/local only, not sent/);
await mkdir(new URL('../runtime/', import.meta.url), {recursive:true});
const capture = await cdp(page.webSocketDebuggerUrl, 'Page.captureScreenshot', {format:'png'});
await writeFile(new URL('../runtime/text-panel-preview.png', import.meta.url), Buffer.from(capture.data, 'base64'));
const report = {testedAt:new Date().toISOString(),url:'https://example.com/',shortHoldCancelled:true,fullHoldOpened:true,opened};
await writeFile(new URL('../runtime/text-panel-audit.json', import.meta.url), JSON.stringify(report,null,2));
console.log(JSON.stringify(report));
