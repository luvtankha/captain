// Disposable synthetic-only verification of the EXACT release OCR runtime.
// Never serializes recognized text. Not a release asset.
importScripts('privacy/privacy-core.js','text/ocr-geometry.js','text/ocr-runtime.js');
self.onmessage = async event => {
  const started=performance.now();
  const assetNames=['vendor/tesseract.min.js','vendor/worker.min.js','vendor/tesseract-core-lstm.wasm.js','vendor/tesseract-core-lstm.wasm','vendor/tesseract-core-simd-lstm.wasm.js','vendor/tesseract-core-simd-lstm.wasm','languages/eng.traineddata.gz'];
  const checks=[];
  for(const name of assetNames){try{const url=new URL('text/'+name,self.location.href).href;
    const response=await fetch(url,{cache:'no-store'});
    const bytes=await response.arrayBuffer();
    checks.push({asset:name,ok:response.ok,redirected:response.url!==url,size:bytes.byteLength});
  }catch{checks.push({asset:name,ok:false});}}
  const capabilities={worker:typeof self.Worker,canvas:typeof self.OffscreenCanvas,
    tesseract:typeof self.Tesseract?.createWorker,crypto:!!self.crypto?.subtle,ready:CaptainLocalOCR.ready,assets:checks};
  try {
    const bitmap=await createImageBitmap(event.data.blob);
    const record=await CaptainLocalOCR.recognize(bitmap,bitmap.width,bitmap.height);
    const plan=CaptainOCRGeometry.review({words:record.words,width:bitmap.width,height:bitmap.height});
    bitmap.close();
    self.postMessage({ok:true,capabilities,ms:Math.round(performance.now()-started),complete:record.complete,
      wordCount:record.words.length,maskCount:plan.regions.length,fullBlackout:plan.fullBlackout});
  } catch { self.postMessage({ok:false,capabilities,ms:Math.round(performance.now()-started),error:'Local OCR unavailable.'}); }
};
