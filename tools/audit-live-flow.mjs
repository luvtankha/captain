import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { cdp, debugJson, evaluate, extensionPath, findSession } from './reload-in-place.mjs';
import {summarize} from './phase-08-score.mjs';
import {sourceFingerprint} from './evidence-provenance.mjs';

// Public navigation and empty login fields only. Never insert credentials.
const coverage = process.argv.includes('--coverage');
const commands = process.argv.slice(2).filter(arg => arg !== '--coverage');
const cases = commands.length ? commands : coverage
  ? ['open wikipedia.org', 'open youtube.com', 'open github.com/login', 'sign in to github',
    'open www.python.org', 'open developer.mozilla.org', 'open duckduckgo.com',
    'open www.amazon.in', 'open www.netflix.com', 'open stackoverflow.com']
  : ['open wikipedia.org', 'open youtube.com', 'open github.com/login', 'sign in to github'];
const busy = new Set(['running', 'waiting_privacy_consent', 'waiting_human']);
const version = await debugJson('/json/version');
const installed = await cdp(version.webSocketDebuggerUrl, 'Extensions.getExtensions');
const extension = installed.extensions.find(item => item.path?.toLowerCase() === extensionPath.toLowerCase());
assert.ok(extension, 'Run npm run demo first.');
const session = await findSession(extension.id);
assert.ok(session?.controller, 'Normal CAPTAIN controller unavailable.');
const controller = session.controller;
const read = () => evaluate(controller, "chrome.runtime.sendMessage({type:'GET_STATE'})");
const initial = await read();
assert.ok(!busy.has(initial.status), 'An existing task is active. Audit did not interrupt it.');
const report = { testedAt: new Date().toISOString(), sourceFingerprint:await sourceFingerprint(), scope: 'public navigation and expected credential handoff in an owned normal tab; no credentials; not universal website certification or heterogeneous task benchmark', steps: [] };
const destination=new URL(coverage ? '../runtime/website-coverage.json' : '../runtime/live-flow-audit.json', import.meta.url);
await mkdir(new URL('../runtime/', import.meta.url), { recursive: true });
const checkpoint=()=>writeFile(destination,JSON.stringify(report,null,2));
const safeContractDiagnostic = value => value &&
  typeof value.path === 'string' && /^[A-Za-z0-9_.\[\]]{1,160}$/.test(value.path) &&
  typeof value.reason === 'string' && /^[a-z-]{2,40}(?: [a-z-]{2,40}){0,4}$/.test(value.reason)
  ? { path: value.path, reason: value.reason } : undefined;
assert.ok(cases.every(task=>/^(?:open [a-z0-9.-]+(?:\/login)?|sign in to github)$/i.test(task)), 'Unsupported audit command.');
// Never reuse the user's existing working tab for test navigation.
const owned=await evaluate(controller,`chrome.tabs.create({windowId:${session.windowId},url:'about:blank',active:true}).then(t=>({id:t.id,incognito:t.incognito,windowId:t.windowId}))`);
assert.equal(owned.incognito,false);assert.equal(owned.windowId,session.windowId);
let targetId = owned.id;
let lastRequestId;
try {
for (const task of cases) {
  assert.ok(/^(?:open [a-z0-9.-]+(?:\/login)?|sign in to github)$/i.test(task), 'Only public navigation and GitHub block verification are allowed.');
  let ownTask = false;
  const requestId = `text-${Date.now().toString(36)}-${(report.steps.length + 1).toString(36)}`;
  lastRequestId=requestId;
  const started=performance.now();
  const entry = { task, consentCount: 0 };
  let stopAudit=false;
  try {
    assert.ok(!busy.has((await read()).status), 'Another command started; stopping audit.');
    const accepted = await evaluate(controller, `chrome.runtime.sendMessage(${JSON.stringify({ type: 'START_TASK', task, requestId, ...(targetId ? { tabId: targetId } : {}) })})`);
    assert.equal(accepted?.ok, true, accepted?.error);
    ownTask = true;
    let current;
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      current = await read();
      if (current.task !== task || current.requestId !== requestId) {
        if (busy.has(current.status)) throw new Error('Another command replaced the audited task; audit stopped.');
        await new Promise(resolve => setTimeout(resolve, 300));
        continue;
      }
      entry.status = current.status;
      entry.message = current.message;
      entry.visualStage = current.visualStage;
      const contractDiagnostic = safeContractDiagnostic(current.contractDiagnostic);
      if (contractDiagnostic) entry.contractDiagnostic = contractDiagnostic;
      if (current.status === 'waiting_privacy_consent') {
        assert.ok(++entry.consentCount <= 3, 'Repeated consent did not stabilize.');
        entry.detected = current.piiDetected;
        entry.vision = current.vision?.status;
        console.log(JSON.stringify({ task, checkpoint: 'privacy-consent', detected: entry.detected }));
        const approved = await evaluate(controller, "chrome.runtime.sendMessage({type:'PRIVACY_CONTINUE'})");
        assert.equal(approved?.ok, true, approved?.error);
      } else if (['complete', 'error'].includes(current.status)) break;
      else if (current.status === 'waiting_human') throw new Error('Website requires human verification.');
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    assert.equal(current?.task, task, 'No matching task result.');
    entry.status = current.status;
    entry.message = current.message;
    entry.visualStage = current.visualStage;
    const contractDiagnostic = safeContractDiagnostic(current.contractDiagnostic);
    if (contractDiagnostic) entry.contractDiagnostic = contractDiagnostic;
    entry.completionStatus = current.completionStatus;
    assert.ok(['complete', 'error'].includes(current.status), 'Task timed out.');
    targetId ||= current.session?.tabId;
    assert.equal(current.session?.tabId, targetId, 'Working tab changed.');
    const tab = await evaluate(controller, `chrome.tabs.get(${targetId}).then(t=>({url:t.url,incognito:t.incognito,windowId:t.windowId}))`);
    assert.equal(tab.incognito, false);
    assert.equal(tab.windowId, session.windowId);
    // Query strings can contain challenge tokens. Persist only host/path.
    const safeUrl = new URL(tab.url);
    entry.url = safeUrl.origin + safeUrl.pathname;
    entry.panel = await evaluate(controller, `chrome.scripting.executeScript({target:{tabId:${targetId}},func:()=>{const h=document.querySelector('#captain-agent-host');const r=h?.getBoundingClientRect();return {present:!!h,width:r?.width,height:r?.height};}}).then(r=>r[0]?.result)`);
    assert.ok(entry.panel?.present && entry.panel.width <= 367 && entry.panel.height <= 641, 'Compact panel missing or oversized.');
    assert.equal(current.status, 'complete', current.message);
    if (task === 'sign in to github') {
      assert.equal(current.completionStatus, 'BLOCKED');
      assert.equal(current.message, 'the site does not allow entry without information access please tell me what to do further ?');
    } else {
      assert.equal(current.completionStatus, 'COMPLETED');
      const expected = new URL('https://' + task.slice(5));
      const actual = new URL(tab.url);
      assert.equal(actual.hostname.replace(/^www\./, ''), expected.hostname.replace(/^www\./, ''));
      if(expected.pathname!=='/')assert.equal(actual.pathname.replace(/\/$/,''),expected.pathname);
    }
    entry.passed = true;
  } catch (error) {
    entry.passed = false;
    entry.error = 'AUDIT_POSTCONDITION_OR_CONNECTION_FAILED';
    const current = await read().catch(()=>null);
    if(!current){entry.error='BROWSER_CONNECTION_UNAVAILABLE';stopAudit=true;}
    if (ownTask && current?.requestId === requestId && busy.has(current.status)) {
      try {
        await evaluate(controller, "chrome.runtime.sendMessage({type:'CANCEL_TASK'})");
        for (let i = 0; i < 20 && busy.has((await read()).status); i++) await new Promise(resolve => setTimeout(resolve, 250));
      } catch {stopAudit=true;}
    }
    if (current && current.task !== task && busy.has(current.status))stopAudit=true;
  }
  entry.elapsedMs=Math.round(performance.now()-started);
  report.steps.push(entry);
  await checkpoint();
  console.log(JSON.stringify(entry));
  if(stopAudit)break;
}
} catch { report.failureClass='AUDIT_INTERRUPTED';
} finally {
  // If a human took over, leave their tab alone, even if their command finished.
  try {
    const current=await read();
    if(current.requestId===lastRequestId&&!busy.has(current.status))await evaluate(controller,
      `chrome.tabs.get(${owned.id}).then(t=>!t.incognito&&t.windowId===${session.windowId}?chrome.tabs.remove(t.id):false)`);
  } catch {}
}
report.passed = report.steps.length === cases.length && report.steps.every(step => step.passed);
report.summary={declared:cases.length,attempted:report.steps.length,
  navigationCompleted:report.steps.filter(s=>s.passed&&s.task.startsWith('open ')).length,
  expectedCredentialHandoffs:report.steps.filter(s=>s.passed&&s.task==='sign in to github').length,
  failedOrUnattempted:cases.length-report.steps.filter(s=>s.passed).length,
  allAttemptTimings:summarize(report.steps.map(s=>s.elapsedMs))};
report.finishedAt=new Date().toISOString();
await checkpoint();
process.exitCode = report.passed ? 0 : 1;
