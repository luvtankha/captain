// Extension-only background document for the original Phase-7 local vision
// worker. The service worker provisions this context; no webpage can embed it.
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  // A content script, website or lookalike extension page cannot submit a
  // screenshot to this privileged worker. A direct service-worker message
  // contains only source pixels that remain inside this extension context.
  if (message?.visionHost !== 'offscreen' || sender?.id !== chrome.runtime.id || sender.tab ||
      sender.url !== chrome.runtime.getURL('action-binding-entry.js')) return;
  if (message.type !== 'VISION_REDACT') return;
  runLocalVision(message).then(result => respond({ ok: true, ...result }), error =>
    respond({ ok: false, error: 'Local visual privacy failed.',
      ...(message.auditGateOnly === true && typeof error?.captainVisionStage === 'string'
        ? { stage: error.captainVisionStage } : {}) }));
  return true;
});
