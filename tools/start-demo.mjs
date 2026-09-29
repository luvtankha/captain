import { access, mkdir, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cdp, debugJson, ensureController, evaluate, extensionPath, findSession, reconnectPanels, reloadInPlace } from './reload-in-place.mjs';
import { ensureCompanionAuthToken, ensureServerRuntime } from './server-runtime.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const chromeCandidates = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
];
async function exists(path) { try { await access(path); return true; } catch { return false; } }
async function reconnectExistingPanels(session) {
  // Starting CAPTAIN again repairs stale website widgets without navigating or
  // refreshing their documents. The report includes any restricted/closed tab.
  const panels = await reconnectPanels(session);
  console.log(JSON.stringify({ panels }));
}
async function provisionCompanionAuth(session, bootstrapToken) {
  if (!session?.controller) throw new Error('A live CAPTAIN controller is required for companion authentication.');
  const extensionId = new URL(session.controller.url).hostname;
  if (!/^[a-p]{32}$/.test(extensionId)) throw new Error('The CAPTAIN extension identity is invalid.');
  const controller = await evaluate(session.controller,
    '({id:chrome.runtime.id,incognito:chrome.extension.inIncognitoContext})');
  if (controller?.id !== extensionId || controller.incognito !== false)
    throw new Error('The trusted CAPTAIN normal-tab extension controller changed.');
  const response = await fetch('http://127.0.0.1:4317/api/companion/session', {
    method: 'POST', headers: { 'content-type': 'application/json',
      'x-captain-auth': bootstrapToken },
    signal: AbortSignal.timeout(5000),
    body: JSON.stringify({ extensionOrigin: `chrome-extension://${extensionId}` })
  });
  if (!response.ok) throw new Error('The local companion refused CAPTAIN session authentication.');
  const { token, expiresAt } = await response.json();
  const now = Date.now();
  const invalidShape = !/^[a-f0-9]{64}$/.test(token || '') ||
    token === bootstrapToken || !Number.isSafeInteger(expiresAt);
  // Bound the expiry to the documented one-hour TTL, allowing a small local
  // clock/scheduler tolerance without accepting a long-lived browser token.
  const invalidExpiry = !Number.isSafeInteger(expiresAt) ||
    expiresAt <= now || expiresAt > now + 60 * 60 * 1000 + 5000;
  if (invalidShape || invalidExpiry)
    throw new Error('The companion returned an invalid short-lived session. ' +
      (invalidShape ? 'Session shape was rejected.' : 'Session expiry was rejected.'));
  const stored = await evaluate(session.controller,
    `chrome.storage.session.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'}).then(()=>chrome.storage.session.set({captainCompanionToken:${JSON.stringify(token)}})).then(()=>chrome.storage.local.remove('captainCompanionToken')).then(()=>chrome.storage.session.get('captainCompanionToken')).then(x=>x.captainCompanionToken)`);
  if (stored !== token) throw new Error('CAPTAIN could not provision companion authentication into the extension.');
}
let browser;
for (const candidate of chromeCandidates) if (await exists(candidate)) { browser = candidate; break; }
if (!browser) throw new Error('Chrome or Edge was not found.');

try { await fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(2000) }); }
catch {
  const ollama = spawn('ollama', ['serve'], { detached: true, stdio: 'ignore', windowsHide: true });
  ollama.on('error', error => console.error(`Optional Ollama service could not start: ${error.message}`));
  ollama.unref();
}
const companionToken = await ensureCompanionAuthToken(root);
const serverRuntime = await ensureServerRuntime(root, { authToken: companionToken });
console.log(`CAPTAIN server ${serverRuntime.version} ${serverRuntime.fingerprint.slice(0, 12)}${serverRuntime.restarted ? ' updated' : ' ready'}.`);

let version;
try { version = await debugJson('/json/version'); } catch {}
let bootstrapTargetId;
if (!version) {
  const profile = join(root, 'runtime', 'browser');
  await mkdir(profile, { recursive: true });
  const child = spawn(browser, [
    `--user-data-dir=${profile}`, '--enable-unsafe-extension-debugging',
    '--remote-debugging-port=9223', '--no-first-run', '--no-default-browser-check',
    '--new-window', 'about:blank',
  ], { detached: true, stdio: 'ignore' });
  child.on('error', error => console.error(`CAPTAIN browser could not start: ${error.message}`));
  child.unref();
  for (let attempt = 0; attempt < 50; attempt++) {
    try { version = await debugJson('/json/version'); break; } catch { await pause(150); }
  }
  if (!version?.webSocketDebuggerUrl) throw new Error('The dedicated CAPTAIN Chrome debugging endpoint did not start.');
  const blanks = (await debugJson('/json/list')).filter(target => target.type === 'page' && target.url === 'about:blank');
  if (blanks.length === 1) bootstrapTargetId = blanks[0].id;
}

const browserUrl = version.webSocketDebuggerUrl;
const { extensions = [] } = await cdp(browserUrl, 'Extensions.getExtensions');
const installed = extensions.find(item => item.path?.toLowerCase() === extensionPath.toLowerCase());
const expected = JSON.parse(await readFile(join(extensionPath, 'manifest.json'), 'utf8')).version;
if (installed) {
  const session = await findSession(installed.id);
  let build;
  if (session) {
    try { build = await evaluate(session.controller, `chrome.runtime.sendMessage({type:'GET_STATE'}).then(state=>state.build||'unknown')`); } catch {}
  }
  if (process.argv.includes('--reload') || (session && build !== expected)) {
    await reloadInPlace();
    const reloaded = await findSession(installed.id);
    await provisionCompanionAuth(reloaded, companionToken);
    console.log('CAPTAIN updated in the existing normal window. Hold E for 4 seconds on a webpage to open the panel.');
  } else {
    const ready = await ensureController(browserUrl, installed.id, { previous: session, bootstrapTargetId });
    await provisionCompanionAuth(ready, companionToken);
    await reconnectExistingPanels(ready);
    console.log(`CAPTAIN is ready in normal window ${ready.windowId}. No demo page was opened. Type “open GitHub” in the controller, or hold E for 4 seconds on a webpage.`);
  }
} else {
  const loaded = await cdp(browserUrl, 'Extensions.loadUnpacked', { path: extensionPath });
  const ready = await ensureController(browserUrl, loaded.id, { bootstrapTargetId });
  await provisionCompanionAuth(ready, companionToken);
  await reconnectExistingPanels(ready);
  console.log(`CAPTAIN is ready in normal window ${ready.windowId}. Type “open GitHub”, or hold E for 4 seconds on a webpage. Website tabs are created only when you ask.`);
}
