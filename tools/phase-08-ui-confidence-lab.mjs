// Research-only threshold sweep of the existing pinned UI ONNX weights.
// The *deployed* detector and fusion thresholds remain unchanged. The single
// previously inspected synthetic form here is DEVELOPMENT data, not held-out.
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { adapter, decodePng, EXPECTED_SHA, lease } from './phase-06-real-inference.mjs';
import ort from 'onnxruntime-web';
const base=new URL('../benchmarks/',import.meta.url);
const truth=JSON.parse((await readFile(new URL('phase-06-ground-truth.json',base),'utf8')).replace(/^\uFEFF/,''));
const raster=decodePng(await readFile(new URL('phase-06-isolated-ui.png',base)));
const iou=(a,b)=>{
 const w=Math.max(0,Math.min(a.x2,b.x2)-Math.max(a.x1,b.x1)),h=Math.max(0,Math.min(a.y2,b.y2)-Math.max(a.y1,b.y1));
 const inter=w*h,union=(a.x2-a.x1)*(a.y2-a.y1)+(b.x2-b.x1)*(b.y2-b.y1)-inter;
 return union>0?inter/union:0;
};
ort.env.wasm.numThreads=1;ort.env.wasm.simd=true;
const records=[];
for(const confidence of [.75,.70,.65,.60,.55,.50,.45,.35,.25]){
 const {detector,runs}=adapter({researchConfidence:confidence});
 const started=performance.now();let record;
 try{
  const result=await detector.detect(raster,raster.width,raster.height,lease);
  const candidates=result.detections.flatMap((item,pi)=>truth.map((expected,ti)=>({pi,ti,iou:iou(item.box,expected.box)})))
    .filter(x=>x.iou>=.5).sort((a,b)=>b.iou-a.iou);
  const ps=new Set(),ts=new Set();for(const x of candidates){if(ps.has(x.pi)||ts.has(x.ti))continue;ps.add(x.pi);ts.add(x.ti);}
  record={confidence,actualModelRuns:runs(),predictions:result.detections.length,tp:ps.size,
    fp:result.detections.length-ps.size,fn:truth.length-ts.size,
    potentiallyAmbiguous:result.detections.filter(item=>truth.filter(t=>iou(item.box,t.box)>=.5).length!==1).length,
    latencyMs:Math.round(performance.now()-started)};
 }catch{record={confidence,actualModelRuns:runs(),failureClass:'MODEL_UNAVAILABLE'};}
 records.push(record);console.log(JSON.stringify(record));
}
const report={schema:'captain.phase08.research-only-ui-threshold.v1',
 checkpointSha256:EXPECTED_SHA,developmentCase:'previously inspected isolated synthetic Edge form',
 untouchedHeldOut:false,originalProductionThreshold:.75,
 note:'Node VM changes only research-source literal; production ONNX adapter and strict fusion remain pinned at .75. Lower confidence is NOT a demonstrated safe production improvement.',
 records};
await mkdir(new URL('../runtime/',import.meta.url),{recursive:true});
await writeFile(new URL('../runtime/phase-08-ui-confidence-lab.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
