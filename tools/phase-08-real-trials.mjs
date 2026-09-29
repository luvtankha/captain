// Original master-plan Phase 8: repeat the *actual* Phase-7 browser workflows.
// Output is a bounded numeric/boolean report, never a child transcript, raw
// screenshot, OCR word, entered value, auth token, or private browser record.
// Run one mode at a time in the already identity-verified CAPTAIN profile.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { summarize } from './phase-08-score.mjs';
import { cdp, debugJson, evaluate, extensionPath, findSession } from './reload-in-place.mjs';

const modes=['--public','--public-dom','--form','--visual'];
const mode = process.argv.find(arg => modes.includes(arg))?.slice(2);
assert.ok(mode, 'Choose exactly one of --public, --public-dom, --form, --visual.');
assert.equal(process.argv.filter(arg => modes.includes(arg)).length, 1);
const root = fileURLToPath(new URL('../', import.meta.url));
const programs = Object.freeze({
  public: ['tools/phase-07-public-smoke.mjs', '--duckduckgo'],
  'public-dom': ['tools/phase-07-public-smoke.mjs', '--duckduckgo','--dom-only'],
  form: ['tools/phase-07-private-form.mjs'],
  visual: ['tools/phase-07-visual-grounding.mjs', '--two-choices']
});
// These fields are already bounded, typed extension-local timeline metrics.
// Never copy timeline metadata, event strings, page content or model output.
const stageTypes = Object.freeze(['PAGE_READY','DOM_EXTRACTION','ACCESSIBILITY_EXTRACTION',
  'PRIVACY_SCAN','SCREEN_CAPTURE','LOCAL_VISION_REDACTION','PERCEPTION_TOTAL',
  'OCR','SANITIZATION_PAYLOAD','NETWORK_AND_SERVER','SERVER_RECEIVE_PARSE',
  'SERVER_PRIVACY_BOUNDARY','PLANNER','ACTION_COMPLETED','PAGE_NAVIGATION']);
async function readSafeStageTimings() {
  const browser=await debugJson('/json/version');
  const {extensions=[]}=await cdp(browser.webSocketDebuggerUrl,'Extensions.getExtensions');
  const owned=extensions.find(item=>item.path?.toLowerCase()===extensionPath.toLowerCase());
  assert.ok(owned?.id,'The exact installed CAPTAIN extension is required.');
  const session=await findSession(owned.id);
  assert.ok(session?.controller && Number.isSafeInteger(session.windowId));
  const read=await evaluate(session.controller,`(async()=>{
    const tab=await chrome.tabs.getCurrent();
    if(!tab?.incognito || tab.windowId!==${session.windowId})return null;
    const state=await chrome.runtime.sendMessage({type:'GET_STATE'});
    return {status:state?.status,events:(state?.timeline||[]).map(item=>({
      type:item?.type,latencyMs:item?.latencyMs,step:item?.step
    }))};
  })()`);
  assert.equal(read?.status,'complete','The real workflow did not leave a complete state.');
  assert.ok(Array.isArray(read.events) && read.events.length>0 && read.events.length<=260);
  const allowed=new Set(stageTypes);
  const stages={};
  for(const event of read.events){
    if(!allowed.has(event.type))continue;
    assert.ok(Number.isSafeInteger(event.latencyMs)&&event.latencyMs>=0&&event.latencyMs<=3600000,
      'Unreviewed numeric stage timing.');
    (stages[event.type]??=[]).push(event.latencyMs);
  }
  return Object.fromEntries(Object.entries(stages).map(([key,values])=>[key,summarize(values)]));
}
const report = {
  schema: 'captain.original-phase-08.real-workflow-trials.v1',
  mode, scope: 'Actual dedicated Incognito extension + existing synthetic/public Phase-7 acceptance scripts',
  plannedRuns: 5, completedRuns: 0, passedRuns: 0, trials: [],
  note: 'Wall-clock is whole child workflow. Stage timing, where present, is captured from the final real extension task timeline as numeric aggregates; private-form standalone actions have no planner timeline. Timing samples are a selected final task for multi-task public/visual workflows, not an entire workflow-stage total. Visual generic semantic verdict remains PARTIAL; the page-owned fixture oracle checks actual A/B.'
};
const bool = (value, name) => assert.equal(value, true, name);
function validate(value) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  if (mode === 'public' || mode === 'public-dom') {
    bool(value.navigation?.independentlyVerifiedHost, 'Public destination not independently verified.');
    bool(value.search?.independentlyVerifiedQuery, 'Public search not independently verified.');
    bool(value.navigation?.outcomeVerified, 'Navigation not verified by extension.');
    bool(value.search?.outcomeVerified, 'Search not verified by extension.');
    assert.equal(value.domOnly, mode === 'public-dom', 'Wrong screenshot-on/off path for comparison.');
    assert.equal(value.searchProvider, 'duckduckgo');
    assert.equal(value.personalDataUsed, false);
  } else if (mode === 'form') {
    for (const key of ['privateWindow', 'syntheticOnly', 'typedEmailPlaceholderVerified',
      'typedPasswordPlaceholderVerified', 'remoteSensitiveWriteBlocked',
      'localInsertionVerified', 'actionResultLocalOnly',
      'unauthenticatedCompanionRejected']) bool(value[key], key);
    assert.equal(value.credentialReturnedByAction, false);
    assert.equal(value.credentialPresentInObservation, false);
    assert.equal(value.personalDataUsed, false);
  } else {
    bool(value.visualGroundingAccepted, 'Real visual task failed.');
    assert.deepEqual(value.trials?.map(item => item.expectedChoice), ['A', 'B']);
    for (const trial of value.trials) {
      assert.equal(trial.terminalState, 'complete');
      assert.equal(trial.completionStatus, 'PARTIAL');
      assert.equal(trial.actualPlanner, 'ollama');
      for (const key of ['clickExecuted', 'pageChoiceVerified', 'exactlyOnePageClick',
        'panelRestored', 'screenshotSettingEnabled', 'noPersonalData']) bool(trial[key], key);
    }
  }
}
try {
  for (let run = 1; run <= report.plannedRuns; run++) {
    const start = performance.now();
    const child = spawnSync(process.execPath, programs[mode], {
      cwd: root, encoding: 'utf8', windowsHide: true,
      timeout: 360000, maxBuffer: 1024 * 1024
    });
    const durationMs = Math.round(performance.now() - start);
    let success = child.status === 0 && !child.error;
    if (success) {
      try { validate(JSON.parse(child.stdout)); } catch { success = false; }
    }
    let stageTimings=null;
    if(success && mode!=='form') {
      try { stageTimings=await readSafeStageTimings(); }
      catch { success=false; }
    }
    // Never save/print the child transcript: it might contain incidental page
    // content on an unexpected exception. Error classification is fixed-enum.
    const trial = { run, passed: success, durationMs, stageTimings,
      failureClass: success ? null : child.error?.code === 'ETIMEDOUT' ? 'TIMEOUT' :
        child.status === 0 ? 'INVALID_RESULT' : 'FAILED_ACCEPTANCE' };
    report.trials.push(trial);
    report.completedRuns++;
    if (success) report.passedRuns++;
    console.log(JSON.stringify(trial));
    // A failed process may leave a task/browser tab active. Do not race it with
    // another trial; retain negative evidence and require a safe fresh preflight.
    if (!success) break;
  }
} finally {
  report.accepted = report.completedRuns === 5 && report.passedRuns === 5;
  report.wallClockMs = summarize(report.trials.map(trial => trial.durationMs));
  report.stageSamples = Object.fromEntries(stageTypes.map(type=>{
    const values=report.trials.filter(t=>t.passed).flatMap(t=>{
      const stats=t.stageTimings?.[type];return stats?[stats.meanMs]:[];
    });
    return [type,summarize(values)];
  }));
  report.finishedAt = new Date().toISOString();
  await mkdir(new URL('../runtime/', import.meta.url), { recursive: true });
  await writeFile(new URL(`../runtime/phase-08-real-${mode}-trials.json`, import.meta.url),
    JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({mode, completedRuns:report.completedRuns,
    passedRuns:report.passedRuns, accepted:report.accepted, wallClockMs:report.wallClockMs}));
  if (!report.accepted) process.exitCode = 1;
}
