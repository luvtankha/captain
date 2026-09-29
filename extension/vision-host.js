// Shared extension-only fail-closed visual-worker lifecycle.
let visionWorker, visionSequence = 0;
const visionPending = new Map();
// Each capture gets a fresh, bounded worker lifetime. Retaining a completed
// ONNX/OCR worker across page transitions can strand a nested Tesseract worker
// in the same disposable browser process. Releasing it after the last reply
// preserves the existing fail-closed image gate and never exposes raw pixels.
function releaseIdleVisionWorker(worker = visionWorker) {
  // A terminated worker may deliver a queued error after its replacement has
  // started. Never let a stale callback terminate a newer privacy operation.
  if (visionPending.size || visionWorker !== worker) return;
  visionWorker = null;
  try { worker?.terminate(); } catch {}
}
function runLocalVision(message) {
  if (typeof Worker !== 'function') return Promise.reject(new Error('This browser cannot start the local vision worker.'));
  if (!visionWorker) {
    const worker = new Worker(chrome.runtime.getURL('vision-worker.js'));
    visionWorker = worker;
    worker.onmessage = event => {
      if (visionWorker !== worker) return;
      const pending = visionPending.get(event.data?.id); if (!pending) return;
      visionPending.delete(event.data.id);
      if (event.data.ok) pending.resolve(event.data.result);
      else {
        const error = new Error('Local visual privacy failed.');
        if (typeof event.data?.stage === 'string' && /^[a-z-]{1,40}$/.test(event.data.stage))
          error.captainVisionStage = event.data.stage;
        pending.reject(error);
      }
      releaseIdleVisionWorker(worker);
    };
    worker.onerror = () => {
      if (visionWorker !== worker) return;
      for (const pending of visionPending.values()) pending.reject(new Error('Local visual privacy failed.'));
      visionPending.clear(); visionWorker = null;
      try { worker.terminate(); } catch {}
    };
  }
  const worker = visionWorker;
  const id = ++visionSequence;
  return new Promise((resolve, reject) => {
    // Cold, integrity-verified OCR loads local WASM/language assets in addition
    // to UltraFace. This timeout is bounded above the OCR stage's own limits;
    // timeout still withholds the screenshot and never falls back to raw pixels.
    const timer = setTimeout(() => {
      if (visionWorker !== worker || !visionPending.has(id)) return;
      visionPending.delete(id);
      reject(new Error('Local visual privacy failed.'));
      // Do not leave a timed-out raw-image/OCR worker running or reuse it for
      // another capture. Terminate its nested local model worker with it.
      for (const pending of visionPending.values()) pending.reject(new Error('Local visual privacy failed.'));
      visionPending.clear(); visionWorker = null;
      try { worker.terminate(); } catch {}
    }, 100000);
    visionPending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
    // UI snapshot is extension-only geometry/lease (no names, text, values).
    // It is never included in the proof or returned to the planner.
    try {
      worker.postMessage({ id, screenshot: message.screenshot, viewport: message.viewport,
        redactionBoxes: message.redactionBoxes, uiSnapshot: message.uiSnapshot,
        ...(message.auditGateOnly === true ? { auditGateOnly: true } : {}) });
    } catch {
      visionPending.delete(id);
      releaseIdleVisionWorker(worker);
      clearTimeout(timer);
      reject(new Error('Local visual privacy failed.'));
    }
  });
}
