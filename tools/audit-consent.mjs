// Test-only continuation for the command the audit itself submitted.
// No field values, screenshots or page text are read by this helper.
const counts = new Map();
export async function advanceAuditConsent(evaluate, state, task) {
  if (state?.task !== task) return;
  if (state.status === 'waiting_human') throw new Error('Website requires human verification; audit paused.');
  if (state.status !== 'waiting_privacy_consent') return;
  const key = state.requestId || task;
  const count = (counts.get(key) || 0) + 1;
  counts.set(key, count);
  if (count > 3) throw new Error('Protected page did not stabilize after three consent checks.');
  const approved = await evaluate(`(async()=>{
    const current=await chrome.runtime.sendMessage({type:'GET_STATE'});
    if(current.task!==${JSON.stringify(task)}||current.status!=='waiting_privacy_consent')return {ok:false};
    const self=await chrome.tabs.getCurrent();
    const tab=await chrome.tabs.get(current.session.tabId);
    if(self.incognito||tab.incognito||self.windowId!==tab.windowId)return {ok:false};
    return chrome.runtime.sendMessage({type:'PRIVACY_CONTINUE'});
  })()`);
  if (!approved?.ok) throw new Error('Audit privacy continuation rejected.');
}
