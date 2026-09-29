import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { cdp, debugJson, evaluate, extensionPath, findSession } from './reload-in-place.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const dwellMs = Math.max(3000, Math.min(15000, Number(process.argv.find(arg => arg.startsWith('--dwell='))?.slice(8)) || 7000));
const portals = [
  ['ISSDC', 'https://www.issdc.gov.in/'],
  ['PRADAN', 'https://pradan1.issdc.gov.in/'],
  ['AstroSat Archive', 'https://webapps.issdc.gov.in/astro_archive/archive/Home.jsp'],
  ['MOSDAC', 'https://www.isro.gov.in/ISRO_EN/MOSDAC.html'],
  ['Bhoonidhi', 'https://bhoonidhi.nrsc.gov.in/'],
  ['Bhuvan', 'https://bhuvan.nrsc.gov.in/'],
  ['VEDAS', 'https://vedas.sac.gov.in/'],
  ['NDEM', 'https://ndem.nrsc.gov.in/'],
];

const version = await debugJson('/json/version');
const installed = await cdp(version.webSocketDebuggerUrl, 'Extensions.getExtensions');
const extension = installed.extensions.find(item => item.path?.toLowerCase() === extensionPath.toLowerCase());
assert.ok(extension, 'Start CAPTAIN first.');
const session = await findSession(extension.id);
assert.ok(session?.controller, 'Normal CAPTAIN controller unavailable.');
const readState = () => evaluate(session.controller, "chrome.runtime.sendMessage({type:'GET_STATE'})");
const pageFor = async tabId => {
  const targetId = await evaluate(session.controller, `(async()=>chrome.debugger.getTargets().then(items=>items.find(item=>item.tabId===${tabId})?.id||''))()`);
  return (await debugJson('/json/list')).find(item => item.id === targetId);
};
async function submit(task, usePagePanel) {
  const current = await readState();
  let socket = session.controller.webSocketDebuggerUrl;
  let prepare = "(()=>{const input=document.querySelector('#task');input.value='';input.focus();return true;})()";
  if (usePagePanel && current.session?.tabId) {
    const page = await pageFor(current.session.tabId);
    const visible = page && await evaluate(page, "(()=>{const host=document.querySelector('#captain-agent-host');return !!host&&getComputedStyle(host).display!=='none'&&!host.shadowRoot.querySelector('.card').classList.contains('collapsed');})()").catch(() => false);
    if (visible) {
      socket = page.webSocketDebuggerUrl;
      prepare = "(()=>{const input=document.querySelector('#captain-agent-host').shadowRoot.querySelector('.task');input.value='';input.focus();return true;})()";
    }
  }
  await cdp(socket, 'Runtime.evaluate', { expression: prepare, userGesture: true });
  for (const character of task) {
    await cdp(socket, 'Input.insertText', { text: character });
    await pause(20);
  }
  await cdp(socket, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await cdp(socket, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
}
async function waitForState(predicate, timeoutMs = 75000) {
  const deadline = Date.now() + timeoutMs;
  let state;
  while (Date.now() < deadline) {
    state = await readState();
    if (predicate(state)) return state;
    await pause(250);
  }
  throw new Error('Timed out waiting for CAPTAIN state.');
}
async function clickConsent(tabId, selector) {
  const page = await pageFor(tabId);
  assert.ok(page, 'Live page debugger target unavailable.');
  await evaluate(session.controller, `chrome.tabs.update(${tabId},{active:true})`);
  const point = await evaluate(page, `(()=>{const button=document.querySelector('#captain-agent-host')?.shadowRoot?.querySelector(${JSON.stringify(selector)});if(!button||button.hidden)return null;button.scrollIntoView({block:'nearest',behavior:'instant'});const r=button.getBoundingClientRect();return r.width&&r.height?{x:r.x+r.width/2,y:r.y+r.height/2}:null;})()`);
  assert.ok(point, `${selector} is not visible.`);
  await cdp(page.webSocketDebuggerUrl, 'Emulation.setFocusEmulationEnabled', { enabled: true });
  await cdp(page.webSocketDebuggerUrl, 'Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
  await cdp(page.webSocketDebuggerUrl, 'Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', buttons: 1, clickCount: 1 });
  await cdp(page.webSocketDebuggerUrl, 'Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', buttons: 0, clickCount: 1 });
}

const results = [];
for (let index = 0; index < portals.length; index++) {
  const [name, url] = portals[index];
  const initial = await readState();
  assert.ok(!['running', 'waiting_privacy_consent', 'waiting_human'].includes(initial.status), `CAPTAIN is busy before ${name}.`);
  const task = `open ${url}`;
  console.log(JSON.stringify({ stage: 'starting', index: index + 1, total: portals.length, name, url }));
  await submit(task, index > 0);
  let state = await waitForState(value => ['waiting_privacy_consent', 'complete', 'error', 'waiting_human'].includes(value.status));
  console.log(JSON.stringify({ stage: 'visible', name, url, status: state.status, phase: state.phase, piiDetected: state.piiDetected, targetTab: state.session?.tabId }));
  // The recording sees the live website, yellow markers, withheld list and local-only preview here.
  await pause(dwellMs);
  if (state.status === 'waiting_privacy_consent') {
    // AstroSat is the credential-form example: visibly approve once without sharing.
    // If a dynamic page asks again after its mandatory fresh scan, stop safely.
    const firstChoice = name === 'AstroSat Archive' ? '.consent-continue' : '.consent-stop';
    await clickConsent(state.session.tabId, firstChoice);
    console.log(JSON.stringify({ stage: firstChoice === '.consent-continue' ? 'continued-without-sharing' : 'stopped-without-sharing', name }));
    state = await waitForState(value => ['waiting_privacy_consent', 'complete', 'error', 'waiting_human'].includes(value.status));
    if (state.status === 'waiting_privacy_consent') {
      await pause(Math.min(3500, dwellMs));
      await clickConsent(state.session.tabId, '.consent-stop');
      console.log(JSON.stringify({ stage: 'stopped-after-fresh-consent', name }));
      state = await waitForState(value => ['complete', 'error', 'waiting_human'].includes(value.status));
    }
  }
  results.push({ name, url, status: state.status, phase: state.phase, piiDetected: Number(state.piiDetected) || 0, targetTab: state.session?.tabId || null });
  console.log(JSON.stringify({ stage: 'finished', ...results.at(-1) }));
  await pause(1200);
}
await mkdir(new URL('../runtime/', import.meta.url), { recursive: true });
await writeFile(new URL('../runtime/portal-demo-report.json', import.meta.url), JSON.stringify({ testedAt: new Date().toISOString(), dwellMs, portals: results }, null, 2));
console.log(JSON.stringify({ stage: 'complete', count: results.length, report: 'runtime/portal-demo-report.json' }));
