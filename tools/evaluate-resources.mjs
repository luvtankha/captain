import {cpus,totalmem,platform,arch} from 'node:os';
import {createHash} from 'node:crypto';
import {mkdir,readFile,readdir,stat,writeFile} from 'node:fs/promises';
import {benchmark} from './phase-06-real-inference.mjs';
import {sourceFingerprint} from './evidence-provenance.mjs';

const assets=[
  ['controls/model.onnx','YOLOv5n UI elements, FP32',7481347,'d29b6210d171e3dc5454e09847aaabce6a0255eaefa565b639e1301a9e933ef9'],
  ['entities/model.quant.onnx','Gravitee BERT-small PII, quantized',28732710,'b227845ff4989c9f7383874b841895dfbdb9a4d7a20ceb39c3f187271894bf2a'],
  ['faces/ultraface-rfb-320.onnx','UltraFace RFB320',1163666,'d7c687949526065ab6a192fdf993360045ce27b0fabf7c9fca5c2437b786b495'],
  ['text/languages/eng.traineddata.gz','Tesseract English compressed data',2952873,'45b4cb346724ac1774f1c36f42f182b887bcdb28ebe63e6fff90ac41f3fcff91']
];
const report={schema:'captain.resource-evaluation.v1',generatedAt:new Date().toISOString(),
  sourceFingerprint:await sourceFingerprint(),hardware:{cpu:cpus()[0]?.model,logicalCPUs:cpus().length,
    installedRamBytes:totalmem(),platform:platform(),arch:arch(),node:process.version},assets:[],
  scope:'CPU-only UI detector in an isolated Node process. Memory is this process, NOT the browser+OCR+PII+companion total. No clean-machine setup or full-agent offline claim.'};
for(const [path,model,bytes,sha256] of assets){
  const data=await readFile(new URL('../extension/'+path,import.meta.url));
  const actualHash=createHash('sha256').update(data).digest('hex');
  report.assets.push({path,model,bytes:data.length,sha256:actualHash,verified:data.length===bytes&&actualHash===sha256});
}
report.totalModelBytes=report.assets.reduce((n,a)=>n+a.bytes,0);
async function treeBytes(url){
  let total=0;
  for(const item of await readdir(url,{withFileTypes:true})){
    if(item.isSymbolicLink())throw Error('Symlink not allowed');
    const next=new URL(item.name+(item.isDirectory()?'/':''),url);
    total+=item.isDirectory()?await treeBytes(next):(await stat(next)).size;
  }
  return total;
}
try {report.packagedExtensionBytes=await treeBytes(new URL('../build/chrome/',import.meta.url));}
catch {report.packagedExtensionBytes=null;}
report.memoryBaselineRssBytes=process.memoryUsage().rss;
report.uiInference=await benchmark(12);
delete report.uiInference.boxes;
report.processLifetimePeakRssKiB=process.resourceUsage().maxRSS||null;
report.finishedAt=new Date().toISOString();
report.verified=report.assets.every(a=>a.verified);
await mkdir(new URL('../runtime/',import.meta.url),{recursive:true});
await writeFile(new URL('../runtime/resource-evaluation.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report));
if(!report.verified)process.exitCode=1;
