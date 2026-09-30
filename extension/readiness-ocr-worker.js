// Unpacked diagnostic only. Generated text and actual OCR output stay here.
importScripts('text/ocr-runtime.js', 'readiness-metrics.js');
self.onmessage = async ({data}) => {
  let bitmap;
  const start=performance.now();
  try {
    if(!['Arial','Times New Roman'].includes(data.font)||![14,20,28].includes(data.size)||
      ![1,1.25].includes(data.zoom)||!['light','dark'].includes(data.theme))throw Error('Unknown fixture');
    const reference=['Mission archive public dataset','Email scientist@example.org','Launch date 2026-09-30'];
    const canvas=new OffscreenCanvas(Math.round(720*data.zoom),Math.round(190*data.zoom));
    const ctx=canvas.getContext('2d',{alpha:false});
    ctx.scale(data.zoom,data.zoom);
    ctx.fillStyle=data.theme==='dark'?'#151515':'#ffffff';ctx.fillRect(0,0,720,190);
    ctx.fillStyle=data.theme==='dark'?'#ffffff':'#111111';
    ctx.font=data.size+'px "'+data.font+'"';ctx.textBaseline='top';
    reference.forEach((line,i)=>ctx.fillText(line,25,20+i*50));
    bitmap=await createImageBitmap(canvas);
    const result=await CaptainLocalOCR.recognize(bitmap,canvas.width,canvas.height);
    if(result.complete!==true)throw Error('Incomplete recognition');
    const score=CaptainReadinessMetrics.recognition(reference.join(' '),result.words.map(w=>w.text).join(' '));
    self.postMessage({ok:true,...score,elapsedMs:Math.round(performance.now()-start)});
  } catch { self.postMessage({ok:false,elapsedMs:Math.round(performance.now()-start)}); }
  finally { bitmap?.close(); }
};
