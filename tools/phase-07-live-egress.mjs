// First master plan, Phase 7: read-only independent CDP observation of the
// real extension's loopback POST bodies during two existing synthetic tasks.
// Never print body, image, token, OCR, page text or any private value.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cdp, debugJson, evaluate, extensionPath, findSession, findIncognitoWorker } from './reload-in-place.mjs';

const browser = await debugJson('/json/version');
const { extensions = [] } = await cdp(browser.webSocketDebuggerUrl, 'Extensions.getExtensions');
const installed = extensions.find(item => item.path?.toLowerCase() === extensionPath.toLowerCase());
assert.ok(installed?.id, 'The exact CAPTAIN unpacked extension is required.');
const session = await findSession(installed.id);
assert.ok(session?.controller && session.windowId, 'Use the existing CAPTAIN Incognito controller.');
const preflight = await evaluate(session.controller, `(async()=>{
  const self=await chrome.tabs.getCurrent(), tabs=await chrome.tabs.query({windowId:self.windowId});
  return {incognito:self.incognito,windowId:self.windowId,tabs:tabs.map(t=>({incognito:t.incognito,url:t.url}))};
})()`);
const reviewed = new Set([
  'http://127.0.0.1:4317/privacy-fixture.html',
  'http://127.0.0.1:4317/demo.html',
  'http://127.0.0.1:4317/demo.html?q=laptop',
  'http://127.0.0.1:4317/benchmark.html?case=login-form',
  'http://127.0.0.1:4317/visual-fixture.html',
  'about:blank',
]);
assert.equal(preflight.incognito, true);
assert.equal(preflight.windowId, session.windowId);
assert.ok(preflight.tabs.every(t => t.incognito &&
  (reviewed.has(t.url) || t.url?.startsWith(`chrome-extension://${installed.id}/`))),
  'An unreviewed private tab exists; no tests or network monitoring started.');
const privateWorker = await findIncognitoWorker(installed.id, session.windowId);
assert.ok(privateWorker?.worker?.webSocketDebuggerUrl, 'Exact private service worker is unavailable.');
const health = await fetch('http://127.0.0.1:4317/health', { signal: AbortSignal.timeout(3000) });
assert.equal(health.ok, true);
const healthState = await health.json();
assert.ok(healthState.planner === 'local-fallback' ||
  (healthState.planner === 'ollama' && healthState.model === 'qwen3-vl:2b'),
  'Only the existing deterministic or approved local Ollama planner is allowed.');

// These values are only from the repository's static localhost demo fixtures.
// Match inside the in-memory request bodies; results expose only booleans.
const syntheticCanaries = [
  'luv.tankha.sih@example.com', 'captain.demo@example.com', '+91 9876543210',
  'ABCDE1234F', '221B Test Road, Delhi', 'NeverTransmitThis',
  '1234 5678 9012 3456',
];
const requests = [];
let unexpectedPostCount = 0;
let disconnected = false, nextId = 1;
const pending = new Map();
const socket = new WebSocket(privateWorker.worker.webSocketDebuggerUrl);
function command(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP monitor timeout.')); }, 10000);
    pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); },
      reject: error => { clearTimeout(timer); reject(error); } });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
const opened = new Promise((resolve, reject) => {
  socket.onopen = resolve;
  socket.onerror = () => reject(new Error('Private worker monitor connection failed.'));
});
socket.onclose = () => { disconnected = true; };
socket.onmessage = event => {
  let item; try { item = JSON.parse(event.data); } catch { return; }
  if (item.id && pending.has(item.id)) {
    const task = pending.get(item.id); pending.delete(item.id);
    item.error ? task.reject(new Error('Private worker monitor command failed.')) : task.resolve(item.result);
  }
  if (item.method !== 'Network.requestWillBeSent') return;
  const request = item.params?.request || {};
  if (request.method !== 'POST') return;
  let destination;
  try { destination = new URL(request.url); } catch { unexpectedPostCount++; return; }
  // Audit every observed private service-worker POST during this test window,
  // not just requests prefiltered to the two expected paths. The monitoring
  // output never includes URL, body, auth token, or page contents.
  if (destination.origin !== 'http://127.0.0.1:4317' ||
      !['/api/agent/step','/api/metrics'].includes(destination.pathname)) {
    unexpectedPostCount++; return;
  }
  requests.push({ path: destination.pathname, requestId: item.params.requestId,
    postData: request.postData, hasPostData: request.hasPostData });
};
async function runFixture(flag) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['tools/phase-07-task-smoke.mjs', flag],
      { cwd: new URL('..', import.meta.url), windowsHide: true, stdio: ['ignore','pipe','pipe'] });
    let output = '', error = '';
    child.stdout.on('data', chunk => { output += chunk; if (output.length > 15000) child.kill(); });
    child.stderr.on('data', chunk => { error += chunk; if (error.length > 10000) child.kill(); });
    child.on('error', () => reject(new Error('Synthetic acceptance process could not start.')));
    child.on('close', code => {
      if (code !== 0) return reject(new Error('Synthetic acceptance task failed; egress is not accepted.'));
      try {
        const report = JSON.parse(output);
        assert.equal(report.scroll?.completionStatus, 'COMPLETED');
        assert.equal(report.scroll?.outcomeVerified, true);
        assert.equal(flag === '--search' ? report.syntheticSearchVerified : report.syntheticClickVerified, true);
        resolve(true);
      } catch { reject(new Error('Synthetic task result could not be independently verified.')); }
    });
  });
}
async function runVisualFixture() {
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,['tools/phase-07-visual-grounding.mjs','--two-choices'],
      {cwd:new URL('..',import.meta.url),windowsHide:true,stdio:['ignore','pipe','pipe']});
    let output='', error='';
    child.stdout.on('data',chunk=>{output+=chunk;if(output.length>15000)child.kill();});
    child.stderr.on('data',chunk=>{error+=chunk;if(error.length>10000)child.kill();});
    child.on('error',()=>reject(new Error('Owned synthetic visual acceptance could not start.')));
    child.on('close',code=>{
      if(code!==0)return reject(new Error('Real visual-only acceptance was not verified.'));
      try{
        const report=JSON.parse(output);
        assert.equal(report.visualGroundingAccepted,true);
        assert.deepEqual(report.trials.map(t=>t.expectedChoice),['A','B']);
        for(const trial of report.trials){
          assert.equal(trial.actualPlanner,'ollama');
          assert.equal(trial.clickExecuted,true);
          assert.equal(trial.pageChoiceVerified,true);
          assert.equal(trial.exactlyOnePageClick,true);
          assert.equal(trial.panelRestored,true);
        // The device independently verifies only the grounded click, not the
        // user's visual color criterion. The separate page-side A/B oracle
        // verifies that criterion here; retain the controller's truthful
        // PARTIAL semantic verdict instead of inflating it to COMPLETED.
        assert.equal(trial.completionStatus,'PARTIAL');
        }
        resolve(true);
      }catch{reject(new Error('Real visual-only acceptance result was not verifiable.'));}
    });
  });
}
let results;
try {
  await opened;
  await command('Network.enable', { maxPostDataSize: 5000000 });
  await runFixture('--click-privacy');
  await runFixture('--search');
  const includeVisual=process.argv.includes('--visual-grounding');
  if(includeVisual){
    assert.equal(healthState.planner,'ollama','Visual-only test needs the approved local model.');
    await runVisualFixture();
  }
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.equal(disconnected, false, 'Private worker monitor disconnected; live egress coverage lost.');
  assert.equal(unexpectedPostCount, 0,
    'A private service-worker POST used an unreviewed destination during the live audit.');
  const plannerRequests = requests.filter(x => x.path === '/api/agent/step');
  assert.ok(plannerRequests.length >= (includeVisual ? 8 : 4),
    'Not all expected real planner requests were independently observed.');
  let genuineProofs = 0;
  for (const request of requests) {
    assert.equal(typeof request.postData, 'string', 'Network monitor did not capture the complete POST body.');
    const body = request.postData;
    assert.ok(!syntheticCanaries.some(value => body.includes(value)), 'Synthetic fixture canary left the extension.');
    const parsed = JSON.parse(body);
    if (request.path === '/api/metrics') {
      assert.equal(parsed.screenshot, undefined);
      assert.equal(parsed.pageText, undefined);
      assert.equal(parsed.searchQuery, undefined);
      continue;
    }
    assert.equal(parsed.context?.redactionBoxes, undefined);
    assert.equal(parsed.context?.rawScreenshot, undefined);
    assert.equal(parsed.context?.pageMetadata?.documentToken, undefined);
    if (parsed.context?.screenshot) {
      const proof = parsed.context.visualPrivacy;
      const image = parsed.context.screenshot;
      assert.equal(proof?.schema, 'captain.visual-privacy.v2');
      assert.equal(proof?.coverageVerified, true);
      assert.equal(proof?.rawScreenshotTransmitted, false);
      assert.equal(proof?.maskPolicy, 'opaque-raster-v1');
      assert.ok(proof?.pixelMaskCount > 0);
      assert.match(image, /^data:image\/jpeg;base64,/);
      assert.equal(createHash('sha256').update(Buffer.from(image.split(',')[1], 'base64')).digest('hex'), proof.imageSha256);
      genuineProofs++;
    }
  }
  assert.ok(genuineProofs >= (includeVisual ? 6 : 2),
    'Expected genuine native screenshot proof-bound outgoing POSTs were not observed.');
  results = { scope:'verified disposable browser; real private-worker CDP network events',
    syntheticTasksVerified:includeVisual?4:2, visualGroundingVerified:includeVisual,
    visualControllerSemanticStatus:includeVisual?'PARTIAL':null,
    visualChoiceIndependentlyVerified:includeVisual,
    plannerPosts:plannerRequests.length,
    metricsPosts:requests.length-plannerRequests.length,
    syntheticCanaryClasses:syntheticCanaries.length,
    genuineV2Proofs:genuineProofs, completePostBodiesChecked:true,
    unexpectedPrivateWorkerPosts:unexpectedPostCount,
    rawFixtureCanaryObservedOutbound:false, noPersonalData:true };
} finally {
  if (socket.readyState === WebSocket.OPEN) {
    try { await command('Network.disable'); } catch {}
  }
  socket.close();
}
console.log(JSON.stringify(results, null, 2));
