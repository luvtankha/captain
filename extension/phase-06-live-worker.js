// Disposable Phase-06 validation harness. Removed from extension before release.
importScripts('vendor/ort.min.js');
let rawStats;
const originalCreate = ort.InferenceSession.create.bind(ort.InferenceSession);
ort.InferenceSession.create = async (...args) => {
  const session = await originalCreate(...args);
  const originalRun = session.run.bind(session);
  session.run = async input => {
    const tensor = input.images;
    // This test-only instrumentation is specific to the pinned YOLO input.
    // A separate ONNX classifier uses `input`, not `images`; never intercept
    // or dereference its private tensor merely for YOLO's numeric probe.
    if (!tensor) return originalRun(input);
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256',tensor.data))]
      .map(x=>x.toString(16).padStart(2,'0')).join('');
    const output = await originalRun(input);
    let maxScore = 0;
    for (const value of Object.values(output)) for (let i=0;i<value.data.length;i+=6)
      maxScore = Math.max(maxScore,value.data[i+4]*value.data[i+5]);
    rawStats={inputSha256:hash,maxScore};
    return output;
  };
  return session;
};
importScripts('controls/ui-model.js', 'controls/ui-fusion.js', 'controls/ui-shape.js',
  'controls/experiments/candidate-adapter.js');
ort.env.wasm.numThreads = 1;
ort.env.wasm.simd = true;
const base = new URL('vendor/', self.location.href);
ort.env.wasm.wasmPaths = {
  mjs: new URL('ort-wasm-simd-threaded.mjs', base).href,
  wasm: new URL('ort-wasm-simd-threaded.wasm', base).href
};
self.onmessage = async event => {
  const begin = performance.now();
  try {
    const bitmap = await createImageBitmap(event.data.blob);
    const imageCanvas = new OffscreenCanvas(bitmap.width,bitmap.height);
    const imageContext = imageCanvas.getContext('2d',{willReadFrequently:true});
    if(!imageContext)throw Error('Local shape fixture unavailable');
    imageContext.drawImage(bitmap,0,0);
    const shapeStarted=performance.now();
    const proposals=CaptainUIImageShape.detect(imageContext.getImageData(0,0,bitmap.width,bitmap.height).data,bitmap.width,bitmap.height);
    const shapeMs=Math.round(performance.now()-shapeStarted);
    const result = await CaptainUIModel.detect(bitmap, bitmap.width, bitmap.height, event.data.lease);
    const candidateStarted=performance.now();
    const alternative=await CaptainUICandidateResearch.detect(bitmap);
    const candidateMs=Math.round(performance.now()-candidateStarted);
    bitmap.close();
    const fusion = Array.isArray(event.data.controls) ? CaptainUIFusion.review({
      result, controls: event.data.controls, lease: event.data.lease,
      modelSha256: result.modelSha256, width: result.width, height: result.height,
      viewport: event.data.viewport, ocrPlan: { fullBlackout: false, regions: [] }
    }) : null;
    self.postMessage({ ok: true, elapsedMs: performance.now() - begin, count: result.detections.length,
      width: result.width, height: result.height,
      shapeBoxes:proposals.map(item=>item.box),shapeMs,
      candidateBoxes:alternative.boxes,candidateMs,candidateSha256:alternative.modelSha256,
      modelSha256: result.modelSha256, outputKeys: Object.keys(result),
      boxes: result.detections.map(({ box }) => box),rawStats,
      fusion: fusion && { fullBlackout: fusion.fullBlackout, maskCount: fusion.regions.length,
        matchCount: fusion.matchedRefs.length } });
  } catch { self.postMessage({ ok: false, error: 'Local UI detector unavailable.' }); }
};
