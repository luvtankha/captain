// Original Phase 8: new frozen synthetic spatial corpus, scored against the
// REAL pinned UI ONNX checkpoint. No model changes, post-hoc labels, personal
// images, remote inference or unsupported general-web accuracy claim.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { adapter, EXPECTED_SHA, lease } from './phase-06-real-inference.mjs';
import { summarize, rates } from './phase-08-score.mjs';
import ort from 'onnxruntime-web';

const SIDE = 640;
const cases = Object.freeze([
  { id: 'heldout-light', background: [248,249,252], control: [220,230,244],
    boxes: [[32,84,254,42],[32,157,254,42],[32,232,136,44],[331,87,236,44]] },
  { id: 'heldout-dark', background: [21,27,42], control: [53,67,93],
    boxes: [[42,92,223,51],[42,174,223,51],[332,93,210,51],[332,177,210,51]] },
  { id: 'heldout-compact', background: [238,239,240], control: [211,216,223],
    boxes: [[26,72,180,34],[26,120,180,34],[26,167,180,34],[26,218,180,34],[235,75,192,35]] },
  { id: 'heldout-zoomed', background: [249,251,253], control: [224,233,241],
    boxes: [[65,115,315,58],[65,202,315,58],[65,292,165,62]] },
  { id: 'heldout-negative', background: [244,246,249], control: [244,246,249], boxes: [] }
]);
// Freeze all labels and pixels before loading/running the model. These labels
// are generator-owned rectangles, not predicted DOM boxes. This corpus was
// not used for training or model selection and was not inspected/relabelled
// after inference; nonetheless synthetic primitives are not real browser UI.
function raster(fixture) {
  const pixels=new Uint8ClampedArray(SIDE*SIDE*4);
  const fill=(x,y,w,h,rgb)=>{
    for(let row=y;row<y+h;row++)for(let col=x;col<x+w;col++){
      const i=(row*SIDE+col)*4;
      pixels.set([rgb[0],rgb[1],rgb[2],255],i);
    }
  };
  fill(0,0,SIDE,SIDE,fixture.background);
  // This header/decor is deliberately NOT labelled as a control.
  fill(0,0,SIDE,48,fixture.background.map(n=>Math.max(0,n-27)));
  for(const [x,y,w,h] of fixture.boxes)fill(x,y,w,h,fixture.control);
  return {width:SIDE,height:SIDE,pixels};
}
const prepared=cases.map(item=>({id:item.id,image:raster(item),truth:item.boxes.map(([x,y,w,h])=>({x1:x,y1:y,x2:x+w,y2:y+h}))}));
const overlaps=(a,b)=>{
  const w=Math.max(0,Math.min(a.x2,b.x2)-Math.max(a.x1,b.x1));
  const h=Math.max(0,Math.min(a.y2,b.y2)-Math.max(a.y1,b.y1));
  const intersection=w*h, union=(a.x2-a.x1)*(a.y2-a.y1)+(b.x2-b.x1)*(b.y2-b.y1)-intersection;
  return union>0?intersection/union:0;
};
function score(truth,detections){
  const pairs=detections.flatMap((item,pi)=>truth.map((box,ti)=>({pi,ti,iou:overlaps(item.box,box)})))
    .filter(x=>x.iou>=.5).sort((a,b)=>b.iou-a.iou);
  const usedPred=new Set(),usedTruth=new Set(),ious=[];
  for(const pair of pairs){
    if(usedPred.has(pair.pi)||usedTruth.has(pair.ti))continue;
    usedPred.add(pair.pi);usedTruth.add(pair.ti);ious.push(pair.iou);
  }
  return {tp:usedPred.size,fp:detections.length-usedPred.size,fn:truth.length-usedTruth.size,
    meanMatchedIoU:ious.length?Number((ious.reduce((a,b)=>a+b,0)/ious.length).toFixed(4)):null};
}
ort.env.wasm.numThreads=1;ort.env.wasm.simd=true;
const {detector,runs}=adapter();
assert.equal(detector.modelSha256,EXPECTED_SHA);
const records=[];
for(const fixture of prepared){
  const start=performance.now();
  let data, error=null;
  try{
    const output=await detector.detect(fixture.image,SIDE,SIDE,lease);
    assert.equal(output.complete,true);assert.equal(output.modelSha256,EXPECTED_SHA);
    data=score(fixture.truth,output.detections);
  }catch{error='MODEL_UNAVAILABLE';data={tp:0,fp:0,fn:fixture.truth.length,meanMatchedIoU:null};}
  const record={case:fixture.id,truthCount:fixture.truth.length,modelResults:data,
    latencyMs:Math.round(performance.now()-start),error};
  records.push(record);console.log(JSON.stringify(record));
}
const aggregate=records.reduce((a,item)=>({tp:a.tp+item.modelResults.tp,fp:a.fp+item.modelResults.fp,
  fn:a.fn+item.modelResults.fn}),{tp:0,fp:0,fn:0});
const report={schema:'captain.original-phase-08.independent-synthetic-model-spatial.v1',
  checkpointSha256:EXPECTED_SHA,confidenceThreshold:.75,iouThreshold:.5,
  declaredBeforeInference:true,postHocRelabelled:false,
  limits:'Five newly generator-labelled synthetic raster cases, not unseen real web pages or photographic face accuracy. Negative case included. Adapter is Node-hosted actual pinned ONNX/WASM; this does not prove live browser model recall.',
  actualModelRuns:runs(),cases:records,aggregate:{...aggregate,...rates(aggregate)},
  timings:summarize(records.map(item=>item.latencyMs)),passed:records.every(item=>item.error===null)};
await mkdir(new URL('../runtime/',import.meta.url),{recursive:true});
await writeFile(new URL('../runtime/phase-08-model-spatial.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({cases:records.length,modelRuns:runs(),aggregate:report.aggregate,timings:report.timings,passed:report.passed}));
if(!report.passed)process.exitCode=1;
