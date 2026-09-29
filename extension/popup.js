const $ = q => document.querySelector(q);
const controllerRoute = new URL(location.href);
const tabId = Number(controllerRoute.searchParams.get('target')) || undefined;
const windowId = Number(controllerRoute.searchParams.get('window')) || undefined;
let pendingRequestId = null, commandSequence = 0, dispatching = false, refreshing = false;
const commandStatus = $('#command-status');
async function refresh() {
  let s;
  try { s = await chrome.runtime.sendMessage({ type: 'GET_STATE' }); }
  catch { commandStatus.textContent = 'Extension disconnected. Reload CAPTAIN before sending another command.'; return; }
  if (s.build && s.build !== '0.5.0') { $('#run').disabled = true; commandStatus.textContent = 'CAPTAIN components are out of date. Run npm run reload in the project folder.'; return; }
  if ($('#target-status')) $('#target-status').textContent = '';
  $('#message').textContent = s.phase === 'SENSITIVE_ACCESS_REQUIRED'
    ? 'the site does not allow entry without information access please tell me what to do further ?'
    : s.status === 'error' ? (s.phaseCode === 'CANCELLED' ? 'Cancelled.' : 'Stopped — check the page panel.') : '';
  $('#phase').textContent = s.status === 'waiting_privacy_consent' ? 'Permission required' :
    s.status === 'waiting_human' ? 'Verification required' : s.status === 'running' ? 'Executing…' : 'Ready';
  $('#step').textContent = s.step || 0; $('#pii').textContent = s.piiDetected || 0;
  $('#latency').textContent = s.latencyMs ? `${(s.latencyMs / 1000).toFixed(1)}s` : '—';
  const waitingHuman = s.status === 'waiting_human';
  const waitingPrivacy = s.status === 'waiting_privacy_consent';
  $('#dot').classList.toggle('running', s.status === 'running' || waitingHuman || waitingPrivacy); $('#shield').textContent = 'Normal tab';
  $('#run').disabled = dispatching || s.status === 'running' || waitingHuman || waitingPrivacy;
  $('#cancel-task').disabled = !['running', 'waiting_human', 'waiting_privacy_consent'].includes(s.status);
  $('#resume-task').hidden = !waitingHuman;
  if (['complete', 'error'].includes(s.status) && s.requestId === pendingRequestId) pendingRequestId = null;
}
$('#resume-task').onclick = async () => {
  $('#resume-task').disabled = true;
  commandStatus.textContent = 'Checking locally that human verification is cleared…';
  try {
    const result = await chrome.runtime.sendMessage({ type: 'RESUME_TASK' });
    commandStatus.textContent = result.ok ? 'Verification cleared. CAPTAIN is resuming.' : result.error;
  } catch (error) { commandStatus.textContent = error.message; }
  finally { $('#resume-task').disabled = false; }
};

async function dispatchCommand(command) {
  if (dispatching || $('#run').disabled) return;
  dispatching = true;
  $('#run').disabled = true;
  pendingRequestId = `text-${Date.now().toString(36)}-${(++commandSequence).toString(36)}`;
  commandStatus.textContent = 'Executing…';
  try {
    const result = await chrome.runtime.sendMessage({ type: 'START_TASK', task: command, tabId, requestId: pendingRequestId });
    commandStatus.textContent = result.ok ? '' : 'Command unavailable — try again.';
  } catch { commandStatus.textContent = 'Connection unavailable.'; }
  finally { dispatching = false; await refresh(); }
}
chrome.runtime.onMessage?.addListener?.((message, _sender, respond) => {
  // Only the dedicated window-bound CAPTAIN controller may own screenshot
  // processing. A transient popup without ?window must never race its reply.
  if (message.type !== 'VISION_REDACT' || message.visionHost === 'offscreen' ||
      !Number.isSafeInteger(windowId) ||
      windowId <= 0 || message.windowId !== windowId) return;
  runLocalVision(message).then(result => respond({ ok: true, ...result }), error =>
    respond({ ok: false, error: 'Local visual privacy failed.',
      ...(message.auditGateOnly === true && typeof error?.captainVisionStage === 'string'
        ? { stage: error.captainVisionStage } : {}) }));
  return true;
});

$('#run').onclick = async () => {
  const task = $('#task').value.trim();
  if (!task) return $('#task').focus();
  await dispatchCommand(task);
};
$('#task').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault(); void $('#run').onclick();
  }
});
$('#settings').onclick = () => chrome.runtime.openOptionsPage();
$('#cancel-task').onclick = async () => {
  try { await chrome.runtime.sendMessage({ type: 'CANCEL_TASK' }); await refresh(); }
  catch { commandStatus.textContent = 'Connection unavailable.'; }
};
async function poll() {
  if (refreshing || document.hidden) return;
  refreshing = true;
  try { await refresh(); } finally { refreshing = false; }
}
chrome.storage.onChanged?.addListener((changes, area) => {
  if (area === 'local' && changes.captainState) void poll();
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) void poll(); });
void poll();
setInterval(poll, 3000);
