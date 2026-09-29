// Reproducible synthetic-only model utility check in the actual unpacked Edge
// extension. Requires ONE existing disposable profile already launched with
// phase-06-live-worker.js available. Never visits the network or real accounts.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
const profile = join(root, 'tests', 'fixtures', 'phase-06-live-profile');
const port = Number((await readFile(join(profile,'DevToolsActivePort'),'utf8')).split(/\r?\n/)[0]);
if(!Number.isInteger(port)||port<1024||port>65535) throw Error('Disposable browser port unavailable.');
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = targets.find(t=>t.type==='page' && t.webSocketDebuggerUrl);
if(!page) throw Error('No disposable page.');
const extensionId = (targets.find(t=>t.type==='service_worker' && /action-binding-entry\.js$/.test(t.url))?.url||'')
  .match(/^chrome-extension:\/\/([a-z]{32})\//)?.[1] || 'mdimbjeanhagcmpcdpdgjjjbeibflkob';
const conn=new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve,reject)=>{conn.addEventListener('open',resolve,{once:true});conn.addEventListener('error',reject,{once:true});});
let id=0;const pending=new Map();
conn.addEventListener('message',event=>{
  const result=JSON.parse(event.data);
  if(!pending.has(result.id))return;
  const entry=pending.get(result.id);pending.delete(result.id);
  result.error?entry.reject(Error(result.error.message)):entry.resolve(result.result);
});
function send(method,params={}) {
  const callId=++id;
  return new Promise((resolve,reject)=>{pending.set(callId,{resolve,reject});conn.send(JSON.stringify({id:callId,method,params}));});
}
async function evaluate(expression){
  const result=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,timeout:45000});
  if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);
  return result.result?.value;
}
await send('Page.enable');await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride',{width:1024,height:768,deviceScaleFactor:1,mobile:false});
const styles={
  light:`body{margin:0;background:#f5f7fc;font:16px Arial;color:#151923}header{padding:16px 40px;background:#273b71;color:white}nav{width:170px;float:left;background:#e9edf7;height:670px;padding:12px}main{margin-left:220px;padding:30px}button,input,select{box-sizing:border-box;font:16px Arial;padding:10px 14px;margin:9px;border:1px solid #a0a8b8;border-radius:6px}button{background:#245dc9;color:white}input,select{background:white;width:420px}nav button{display:block;width:150px}label{display:block;margin-top:12px}`,
  dark:`body{margin:0;background:#161a24;color:#e8eaf0;font:16px Arial}header{background:#202735;padding:20px 36px}main{padding:26px 38px}section{display:grid;grid-template-columns:1fr 1fr;gap:22px}article{background:#252b3a;padding:18px;border:1px solid #465062;border-radius:10px}button,input,select{font:16px Arial;padding:11px;margin:8px;background:#30394b;color:white;border:1px solid #6d7d98;border-radius:7px}button{background:#395bc0;cursor:pointer}input{width:320px}`,
  compact:`body{margin:0;font:14px Arial;color:#262932;background:#fafafa}header{background:#f0f0f3;padding:10px 20px}main{padding:18px 30px}button,input,select{font:14px Arial;padding:7px;margin:5px;border:1px solid #858b97}button{background:#e4e7f0}input{width:260px}table{border-collapse:collapse;width:95%}td,th{border-bottom:1px solid #ddd;padding:10px;text-align:left}a{color:#245dc9}`,
  large:`body{margin:0;background:#fafcff;font:18px Arial;color:#1a2539}header{padding:25px;background:#274aa5;color:#fff}main{padding:35px 90px}button,input,select{font:18px Arial;padding:14px;margin:14px;border:1px solid #7b91b4;border-radius:12px}input{width:650px}button{color:white;background:#207b63}section{padding:16px;background:white;border:1px solid #ccd9ed;border-radius:16px}`
};
const cases=[
  {name:'light-form',theme:'light',body:`<header>CAPTAIN Synthetic Control Panel</header><nav><button>Home</button><button>Reports</button><button>Settings</button></nav><main><h2>Example form</h2><label>Reference number</label><input placeholder="Enter sample text"><label>Email</label><input type="email" placeholder="demo@example.test"><label>Category</label><select><option>General</option><option>Other</option></select><p><button>Save draft</button><button>Preview</button></p></main>`},
  {name:'dark-dashboard',theme:'dark',body:`<header>Local Test Dashboard</header><main><h2>Overview</h2><section><article><h3>Filter data</h3><input placeholder="Search synthetic items"><button>Apply filter</button><button>Clear</button></article><article><h3>Demo actions</h3><button>View details</button><button>Show chart</button><select><option>Today</option></select></article></section><p><button>Open panel</button><button>New item</button></p></main>`},
  {name:'compact-table',theme:'compact',body:`<header>Offline Inventory</header><main><h2>Fixture rows</h2><input placeholder="Find entries"><button>Search</button><table><tr><th>Item</th><th>Details</th></tr><tr><td>Example A</td><td><button>Inspect</button><a href="#local">Read</a></td></tr><tr><td>Example B</td><td><button>Inspect</button><a href="#local">Read</a></td></tr><tr><td>Example C</td><td><button>Inspect</button><a href="#local">Read</a></td></tr></table><button>Next page</button></main>`},
  {name:'large-login',theme:'large',body:`<header>Private Local Demo</header><main><section><h2>Sample sign-in form (no account)</h2><label>Sample email</label><input type="email" placeholder="synthetic@example.test"><label>Sample password</label><input type="password" value=""><p><button>Continue</button><button>Cancel</button></p></section></main>`}
];
const extensionPage=`chrome-extension://${extensionId}/phase-06-live.html`;
const overlap=(a,b)=>{
  const x=Math.max(0,Math.min(a.x2,b.x2)-Math.max(a.x1,b.x1));
  const y=Math.max(0,Math.min(a.y2,b.y2)-Math.max(a.y1,b.y1));const common=x*y;
  return common/((a.x2-a.x1)*(a.y2-a.y1)+(b.x2-b.x1)*(b.y2-b.y1)-common);
};
const output=[];
for(const fixture of cases){
  const html=`<!doctype html><meta charset="utf-8"><style>${styles[fixture.theme]}</style>${fixture.body}`;
  const nav=await send('Page.navigate',{url:'data:text/html;charset=utf-8,'+encodeURIComponent(html)});
  if(nav.errorText)throw Error(nav.errorText);
  await new Promise(resolve=>setTimeout(resolve,200));
  const controls=await evaluate(`[...document.querySelectorAll('button,input,select,a')].map(el=>{const r=el.getBoundingClientRect();return {x1:r.left,y1:r.top,x2:r.right,y2:r.bottom}})`);
  const shot=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
  if(!shot.data)throw Error('Synthetic screenshot failed.');
  const extNav=await send('Page.navigate',{url:extensionPage});
  if(extNav.errorText)throw Error(extNav.errorText);
  await new Promise(resolve=>setTimeout(resolve,200));
  const expr=`(async()=>{const blob=await (await fetch('data:image/png;base64,${shot.data}')).blob();
    const worker=new Worker(chrome.runtime.getURL('phase-06-live-worker.js'));
    const lease={documentToken:'synthetic-document-123',observationId:'synthetic-observation-456',domRevision:1,geometryRevision:1};
    return await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{worker.terminate();reject(Error('Local inference timeout'));},30000);
      worker.onmessage=e=>{clearTimeout(timer);worker.terminate();resolve(e.data)};
      worker.onerror=()=>{clearTimeout(timer);worker.terminate();reject(Error('Local worker failed'))};
      worker.postMessage({blob,lease,viewport:{width:1024,height:768,devicePixelRatio:1},
        controls:${JSON.stringify(controls.map((box,i)=>({ref:'c'+(i+1),
          source:'dom',visible:true,enabled:true,sensitive:false,
          box:{x:box.x1,y:box.y1,width:box.x2-box.x1,height:box.y2-box.y1},
          lease:{documentToken:'synthetic-document-123',observationId:'synthetic-observation-456',domRevision:1,geometryRevision:1}})))}})});})()`;
  const actual=await evaluate(expr);
  const candidates=(actual.boxes||[]).flatMap((box,di)=>controls.map((truth,ti)=>({di,ti,iou:overlap(box,truth)})))
    .filter(p=>p.iou>=0.5).sort((a,b)=>b.iou-a.iou);
  const usedD=new Set(),usedT=new Set();
  for(const p of candidates){if(usedD.has(p.di)||usedT.has(p.ti))continue;usedD.add(p.di);usedT.add(p.ti);}
  output.push({name:fixture.name,groundTruth:controls.length,modelOK:actual.ok,modelSha256:actual.modelSha256,
    predictions:actual.count||0,truePositive:usedD.size,falsePositive:(actual.count||0)-usedD.size,
    falseNegative:controls.length-usedT.size,recall:controls.length?usedT.size/controls.length:null,
    maxScore:actual.rawStats?.maxScore??null,modelElapsedMs:actual.elapsedMs,
    fusion:actual.fusion||null,
    scope:'single fixture, local synthetic DOM boxes, IoU>=0.5 and confidence>=0.75'});
}
conn.close();
const result={browser:'actual Edge unpacked extension, four generated synthetic pages; not real-world representative',
  confidenceThreshold:0.75,modelSha256:'d29b6210d171e3dc5454e09847aaabce6a0255eaefa565b639e1301a9e933ef9',fixtures:output,
  aggregate:{groundTruth:output.reduce((s,x)=>s+x.groundTruth,0),truePositive:output.reduce((s,x)=>s+x.truePositive,0),
    falsePositive:output.reduce((s,x)=>s+x.falsePositive,0),falseNegative:output.reduce((s,x)=>s+x.falseNegative,0)}};
result.aggregate.recall=result.aggregate.truePositive/result.aggregate.groundTruth;
await writeFile(new URL('../benchmarks/phase-06-multipage-browser.json',import.meta.url),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result,null,2));
if(output.some(f=>!f.modelOK||f.modelSha256!==result.modelSha256 ||
    !f.fusion || (f.predictions===0 ? !f.fusion.fullBlackout : f.fusion.fullBlackout)))process.exitCode=1;
