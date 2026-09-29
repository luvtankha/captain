// Research-only pinned synthetic ONNX benchmark. Not part of extension package.
// The candidate is an independently converted ONNX; source weight lineage and
// redistribution terms must be verified before any production integration.
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import ort from 'onnxruntime-web';
import { syntheticRaster, decodePng, SyntheticCanvas } from './phase-06-real-inference.mjs';
import { summarize, rates } from './phase-08-score.mjs';
const candidate=await readFile(new URL('../experiments/detectors/omniparser-community-int8.onnx',import.meta.url));
const SHA='ee3cb8e8f527b1f2a18e9553d03dc8a08de21bd8b5423a505dc014c8d107f2d0';
if(candidate.length!==3226312||createHash('sha256').update(candidate).digest('hex')!==SHA)throw Error('Research checkpoint changed.');
ort.env.wasm.numThreads=1;ort.env.wasm.simd=true;
const session=await ort.InferenceSession.create(new Uint8Array(candidate),{executionProviders:['wasm'],graphOptimizationLevel:'all'});
if(session.inputNames.length!==1||session.outputNames.length!==1)throw Error('ONNX tensor count changed.');
const inputName=session.inputNames[0],outputName=session.outputNames[0];
const overlap=(a,b)=>{const i=Math.max(0,Math.min(a.x2,b.x2)-Math.max(a.x1,b.x1))*Math.max(0,Math.min(a.y2,b.y2)-Math.max(a.y1,b.y1));const u=(a.x2-a.x1)*(a.y2-a.y1)+(b.x2-b.x1)*(b.y2-b.y1)-i;return u>0?i/u:0;};
const input=(raster,side=640)=>{
 const scale=Math.min(side/raster.width,side/raster.height),dw=Math.round(raster.width*scale),dh=Math.round(raster.height*scale);
 const ox=Math.floor((side-dw)/2),oy=Math.floor((side-dh)/2);
 const canvas=new SyntheticCanvas(side,side),context=canvas.getContext('2d');
 context.fillStyle='#727272';context.fillRect(0,0,side,side);
 context.drawImage(raster,0,0,raster.width,raster.height,ox,oy,dw,dh);
 const plane=side*side,out=new Float32Array(plane*3);
 for(let i=0;i<plane;i++){out[i]=canvas.pixels[i*4]/255;out[plane+i]=canvas.pixels[i*4+1]/255;out[2*plane+i]=canvas.pixels[i*4+2]/255;}
 return {tensor:new ort.Tensor('float32',out,[1,3,side,side]),scale,ox,oy};
};
function decode(tensor,confidence=.25){const d=tensor?.data,n=tensor?.dims?.[2];if(tensor?.type!=='float32'||tensor.dims?.[0]!==1||tensor.dims[1]!==5||n>40000||n<1||d.length!==5*n)throw Error('Unknown candidate output.');let high=0;const proposals=[];for(let i=0;i<n;i++){const c=d[4*n+i];if(!Number.isFinite(c))throw Error('Nonfinite candidate confidence');high=Math.max(c,high);if(c<confidence)continue;const [x,y,w,h]=[d[i],d[n+i],d[2*n+i],d[3*n+i]];if(![x,y,w,h].every(Number.isFinite)||w<=0||h<=0)continue;const box={x1:x-w/2,y1:y-h/2,x2:x+w/2,y2:y+h/2};if(box.x1<0||box.y1<0||box.x2>640||box.y2>640)continue;proposals.push({box,c});if(proposals.length>1024)throw Error('Too many candidate proposals.');}proposals.sort((a,b)=>b.c-a.c);const keep=[];for(const item of proposals)if(keep.every(k=>overlap(item.box,k.box)<.45)){keep.push(item);if(keep.length>128)break;}return {boxes:keep.map(k=>k.box),maxScore:high,proposalCount:proposals.length};}
const raster=syntheticRaster();const png=decodePng(await readFile(new URL('../benchmarks/phase-06-isolated-ui.png',import.meta.url)));
const truths=[[52,142,252,46],[52,210,252,46],[52,281,124,43],[190,281,114,43]].map(([x,y,w,h])=>({x1:x,y1:y,x2:x+w,y2:y+h}));
const textTruth=JSON.parse((await readFile(new URL('../benchmarks/phase-06-ground-truth.json',import.meta.url),'utf8')).replace(/^\uFEFF/,''))
  .map(x=>x.box);
const test=[{name:'generated-controls',image:raster,truth:truths},{name:'inspected-browser-form',image:png,truth:textTruth}];
const report={schema:'captain.phase08.research-community-onnx.v1',sha256:SHA,source:'onnx-community/OmniParser-icon_detect main model_int8.onnx',notForProduction:true,
 scope:'Two inspected/generator-labelled synthetic development images; never untouched held-out or genuine private browser inference.',cases:[]};
for(const sample of test){const processed=input(sample.image);const start=performance.now();const result=await session.run({[inputName]:processed.tensor});const inferMs=Math.round(performance.now()-start);for(const threshold of [.75,.5,.35,.25,.1]){const decoded=decode(result[outputName],threshold);const boxes=decoded.boxes.map(b=>({x1:(b.x1-processed.ox)/processed.scale,y1:(b.y1-processed.oy)/processed.scale,x2:(b.x2-processed.ox)/processed.scale,y2:(b.y2-processed.oy)/processed.scale}));const pairs=boxes.flatMap((b,j)=>sample.truth.map((t,k)=>({j,k,iou:overlap(b,t)}))).filter(x=>x.iou>=.5).sort((a,b)=>b.iou-a.iou);const found=new Set(),matched=new Set();for(const pair of pairs){if(found.has(pair.j)||matched.has(pair.k))continue;found.add(pair.j);matched.add(pair.k);}const record={name:sample.name,threshold,truthCount:sample.truth.length,outputDims:result[outputName].dims,tp:found.size,fp:boxes.length-found.size,fn:sample.truth.length-matched.size,proposals:decoded.proposalCount,maxScore:Number(decoded.maxScore.toFixed(4)),inferMs};report.cases.push(record);console.log(JSON.stringify(record));}}
await mkdir(new URL('../runtime/',import.meta.url),{recursive:true});await writeFile(new URL('../runtime/phase-08-ui-community-research.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
await session.release();
