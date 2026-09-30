import {run} from 'node:test';
import {mkdir,readdir,writeFile} from 'node:fs/promises';
import {basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {sourceFingerprint,testCategory} from './evidence-provenance.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const files=(await readdir(new URL('../tests/',import.meta.url))).filter(n=>n.endsWith('.test.mjs')).sort();
const report={schema:'captain.regression-evidence.v1',generatedAt:new Date().toISOString(),
  sourceFingerprint:await sourceFingerprint(),node:process.version,
  scope:'Software tests, including synthetic and server integration tests; not live website reliability. Exclusive categories assigned by filename; file counts are auditable below.',files:[],failedFiles:[]};
const stream=run({files:files.map(n=>fileURLToPath(new URL('../tests/'+n,import.meta.url))),cwd:root});
for await (const event of stream) {
  const {type,data}=event;
  if(type==='test:summary') {
    const result={counts:data.counts,success:data.success,durationMs:data.duration_ms};
    if(data.file)report.files.push({file:basename(data.file),category:testCategory(basename(data.file)),...result});
    else report.summary=result;
  }
  if(type==='test:fail'&&data.file&&!report.failedFiles.includes(basename(data.file)))
    report.failedFiles.push(basename(data.file));
}
report.categories={};
for(const row of report.files) {
  const category=report.categories[row.category]||={files:0,tests:0,passed:0,failed:0,skipped:0,cancelled:0};category.files++;
  for(const key of ['tests','passed','failed','skipped','cancelled'])category[key]+=row.counts[key];
}
report.complete=report.files.length===files.length&&!!report.summary&&
  report.files.reduce((n,f)=>n+f.counts.tests,0)===report.summary.counts.tests;
report.finishedAt=new Date().toISOString();
await mkdir(new URL('../runtime/',import.meta.url),{recursive:true});
await writeFile(new URL('../runtime/regression-evidence.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({complete:report.complete,summary:report.summary,categories:report.categories,failedFiles:report.failedFiles}));
if(!report.complete||!report.summary?.success)process.exitCode=1;
