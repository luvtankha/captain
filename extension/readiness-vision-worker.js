// Unpacked diagnostic only; excluded from both release packages.
importScripts('vendor/ort.min.js', 'controls/ui-model.js', 'controls/ui-fusion.js');
ort.env.wasm.numThreads = 1;
ort.env.wasm.simd = true;
const base = new URL('vendor/', self.location.href);
ort.env.wasm.wasmPaths = {
  mjs: new URL('ort-wasm-simd-threaded.mjs', base).href,
  wasm: new URL('ort-wasm-simd-threaded.wasm', base).href
};
self.onmessage = async ({data}) => {
  let bitmap;
  const start = performance.now();
  try {
    bitmap = await createImageBitmap(data.blob);
    const result = await CaptainUIModel.detect(bitmap, bitmap.width, bitmap.height, data.lease);
    const fusion = CaptainUIFusion.review({result, controls:data.controls, lease:data.lease,
      modelSha256:result.modelSha256, width:result.width, height:result.height,
      viewport:data.viewport, ocrPlan:{fullBlackout:false, regions:[]}});
    self.postMessage({ok:true, elapsedMs:performance.now()-start,
      width:result.width, height:result.height, modelSha256:result.modelSha256,
      count:result.detections.length, boxes:result.detections.map(d=>d.box),
      fusion:{fullBlackout:fusion.fullBlackout}});
  } catch { self.postMessage({ok:false}); }
  finally { bitmap?.close(); }
};
