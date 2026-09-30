import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {sourceFingerprint} from './evidence-provenance.mjs';

// Sequential timing prevents our own tests from competing for the CPU.
const steps=[
  ['regression','collect-test-evidence.mjs','regression-evidence.json'],
  ['geometry','phase-08-evaluate.mjs','normal-geometry-evaluation.json'],
  ['vision','evaluate-vision.mjs','normal-visual-evaluation.json'],
  ['ocr','evaluate-ocr.mjs','ocr-evaluation.json'],
  ['resources','evaluate-resources.mjs','resource-evaluation.json']
];
const report={schema:'captain.readiness-evaluation.v1',generatedAt:new Date().toISOString(),
  runId:randomUUID(),
  sourceFingerprint:await sourceFingerprint(),steps:[],
  notMeasured:['real-world visual/PII recall','20–50 heterogeneous live tasks','whole-browser peak CPU/RAM',
    'clean-machine setup time','manual-vs-agent time savings','full-agent offline workflow','Firefox runtime']};
const snapshotDirectory=new URL('../runtime/readiness-runs/'+report.runId+'/',import.meta.url);
await mkdir(snapshotDirectory,{recursive:true});
for(const [name,script,file] of steps){
  console.log('Evaluating '+name+'…');
  const start=Date.now();
  const exitCode=await new Promise(resolve=>{
    const child=spawn(process.execPath,[fileURLToPath(new URL(script,import.meta.url))],{
      cwd:fileURLToPath(new URL('../',import.meta.url)),stdio:['ignore','ignore','ignore'],windowsHide:true});
    child.once('error',()=>resolve(-1));child.once('exit',code=>resolve(code??-1));
  });
  let evidence=null,raw=null;
  try{raw=await readFile(new URL('../runtime/'+file,import.meta.url),'utf8');evidence=JSON.parse(raw);}catch{}
  const fresh=!!evidence&&Date.parse(evidence.generatedAt)>=start&&
    evidence.sourceFingerprint===report.sourceFingerprint;
  if(fresh)await writeFile(new URL(file,snapshotDirectory),raw);
  report.steps.push({name,exitCode,fresh,elapsedMs:Date.now()-start,
    evidence:fresh?'readiness-runs/'+report.runId+'/'+file:null,
    evidenceSha256:fresh?createHash('sha256').update(raw).digest('hex'):null,
    result:fresh?(evidence.summary??{verified:evidence.verified,hardware:evidence.hardware,
      totalModelBytes:evidence.totalModelBytes,packagedExtensionBytes:evidence.packagedExtensionBytes,
      uiInference:evidence.uiInference,processLifetimePeakRssKiB:evidence.processLifetimePeakRssKiB}):null});
  console.log(JSON.stringify(report.steps.at(-1)));
}
report.sourceUnchanged=report.sourceFingerprint===await sourceFingerprint();
report.allMeasuredGatesPassed=report.sourceUnchanged&&report.steps.every(s=>s.exitCode===0&&s.fresh);
report.publicReleaseReady=false; // Passing this controlled suite is not deployment certification.
report.finishedAt=new Date().toISOString();
await mkdir(new URL('../runtime/',import.meta.url),{recursive:true});
await writeFile(new URL('../runtime/readiness-evaluation.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
await writeFile(new URL('summary.json',snapshotDirectory),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({allMeasuredGatesPassed:report.allMeasuredGatesPassed,report:'runtime/readiness-evaluation.json'}));
if(!report.allMeasuredGatesPassed)process.exitCode=1;
