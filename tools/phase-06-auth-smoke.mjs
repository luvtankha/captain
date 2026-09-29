// Original master-plan Phase 6: live authentication acceptance in CAPTAIN's
// existing dedicated Incognito profile, not a general browser or personal tab.
// Do not print, persist, or send the real companion credential to any model.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { cdp, debugJson, evaluate, extensionPath, findSession } from './reload-in-place.mjs';
import { expectedServerRuntime } from './server-runtime.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const endpoint = 'http://127.0.0.1:4317';
const healthResponse = await fetch(endpoint + '/health', { signal: AbortSignal.timeout(4000) });
assert.equal(healthResponse.status, 200);
const health = await healthResponse.json();
assert.equal(health.ok, true);
assert.equal(health.service, 'captain');
assert.equal(health.authRequired, true);
assert.equal(health.fingerprint, expectedServerRuntime(root).fingerprint, 'Wrong or stale CAPTAIN companion is listening.');
const bootstrapToken = (await readFile(join(root, 'runtime', 'captain-companion-auth.txt'), 'utf8')).trim();
assert.match(bootstrapToken, /^[a-f0-9]{64}$/);

const browser = await debugJson('/json/version');
const { extensions = [] } = await cdp(browser.webSocketDebuggerUrl, 'Extensions.getExtensions');
const installed = extensions.find(item => item.path?.toLowerCase() === extensionPath.toLowerCase());
assert.ok(installed?.id, 'Only CAPTAIN’s unpacked workspace extension may be tested.');
const session = await findSession(installed.id);
assert.ok(session?.windowId && session.controller?.webSocketDebuggerUrl, 'Dedicated private controller missing.');
const safeState = await evaluate(session.controller, `(async()=>{
  const self=await chrome.tabs.getCurrent();
  const tabs=await chrome.tabs.query({windowId:self.windowId});
  const credential=(await chrome.storage.session.get('captainCompanionToken')).captainCompanionToken;
  const legacy=(await chrome.storage.local.get('captainCompanionToken')).captainCompanionToken;
  return {incognito:self.incognito,windowId:self.windowId,credential,legacyPresent:legacy!==undefined,
    safeTabs:tabs.every(tab=>tab.incognito&&(
      tab.url?.startsWith(chrome.runtime.getURL(''))||
      ['http://127.0.0.1:4317/demo.html','http://127.0.0.1:4317/demo.html?q=laptop',
       'http://127.0.0.1:4317/privacy-fixture.html',
       'http://127.0.0.1:4317/benchmark.html?case=login-form'].includes(tab.url)
    ))};
})()`);
assert.equal(safeState.incognito, true);
assert.equal(safeState.windowId, session.windowId);
assert.equal(safeState.safeTabs, true, 'Unexpected tab in disposable window; abort before any task.');
assert.match(safeState.credential, /^[a-f0-9]{64}$/);
assert.notEqual(safeState.credential, bootstrapToken, 'Bootstrap credential must never enter browser session.');
assert.equal(safeState.legacyPresent, false, 'Legacy content-script-readable token remains.');

const body = JSON.stringify({task:'Scroll down',context:{url:'about:blank',title:'New browser tab',elements:[]},history:[]});
const expectedOrigin = `chrome-extension://${installed.id}`;
for (const route of ['/api/agent/step','/api/metrics']) {
  for (const header of [null, 'b'.repeat(64), bootstrapToken, safeState.credential]) {
    const response = await fetch(endpoint + route, {method:'POST',headers:{
      'content-type':'application/json',...(header?{'x-captain-auth':header}:{})
    },body,signal:AbortSignal.timeout(4000)});
    assert.equal(response.status, 401, 'Unauthenticated client reached '+route);
    assert.equal((await response.json()).code, 'CAPTAIN_COMPANION_AUTH');
  }
  const forged = await fetch(endpoint + route, {method:'POST',headers:{
    'content-type':'application/json','origin':'chrome-extension://' + 'a'.repeat(32),
    'x-captain-auth':safeState.credential
  },body,signal:AbortSignal.timeout(4000)});
  assert.equal(forged.status, 403, 'A different extension origin was accepted.');
}
const accepted = await fetch(endpoint + '/api/agent/step', {method:'POST',headers:{
  'content-type':'application/json','origin':expectedOrigin,
  'x-captain-auth':safeState.credential
},body,signal:AbortSignal.timeout(4000)});
assert.equal(accepted.status, 200, 'Bound extension credential was rejected.');
assert.ok((await accepted.json()).action);
console.log(JSON.stringify({
  phase:'original-6',privateWindow:true,extensionMatched:true,
  freshOriginBoundSession:true,bootstrapCredentialExcludedFromBrowser:true,
  legacyLocalCredentialRemoved:true,unboundAndWrongTokenRejected:true,
  wrongExtensionOriginRejected:true,protectedRoutes:2,personalDataUsed:false
},null,2));
