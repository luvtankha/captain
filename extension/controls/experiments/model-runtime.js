// TEST-ONLY local second-stage crop classifier. Never imported by production
// capture or release. The same source image and proposals stay inside the
// disposable private extension worker. Only numeric scores leave to Node.
(function(root){
 'use strict';
 const ERROR='Research classifier unavailable.';
 const PATH='controls/experiments/mobilenetv3_small.onnx';
 const SHA='5e17d4c43de2927ca3f6ab56e46edf44d2d5ef991fa0afc5d1892bbbf65fbf05';
 const SIZE=6142536;
 const CLASSES=Object.freeze(['button','checkbox','container','dropdown','icon_button',
   'image','label','link','menu_item','scrollbar','slider','tab','text_input','toggle','unknown']);
 const ACTIVE=new Set(['button','checkbox','dropdown','icon_button','link','menu_item','tab','text_input','toggle']);
 const mean=[.485,.456,.406],std=[.229,.224,.225];
 let promise;
 root.__researchCropStage='INIT';
 const fail=()=>{throw Error(ERROR)};
 async function session(){
  promise ||= (async()=>{
   root.__researchCropStage='ASSET_FETCH';
   if(!root.ort?.InferenceSession||!root.ort?.Tensor||!root.crypto?.subtle||!root.self?.location?.href)fail();
   const parent=new URL(root.self.location.href),url=new URL(PATH,parent);
   if(url.protocol!==parent.protocol||url.host!==parent.host||!['chrome-extension:','moz-extension:'].includes(url.protocol))fail();
   const response=await root.fetch(url.href,{cache:'no-store'});
   if(!response.ok||response.url&&response.url!==url.href)fail();
   const bytes=await response.arrayBuffer();if(bytes.byteLength!==SIZE)fail();
   const sha=[...new Uint8Array(await root.crypto.subtle.digest('SHA-256',bytes))]
     .map(n=>n.toString(16).padStart(2,'0')).join('');
   if(sha!==SHA)fail();
   root.__researchCropStage='MODEL_CREATE';
   const s=await root.ort.InferenceSession.create(new Uint8Array(bytes),{executionProviders:['wasm'],graphOptimizationLevel:'all'});
   if(s.inputNames?.length!==1||s.inputNames[0]!=='input'||s.outputNames?.length!==1||s.outputNames[0]!=='output')fail();
   root.__researchCropStage='MODEL_SELFTEST';
   // Model/operator compatibility is checked with all-zero synthetic pixels,
   // never a customer/browser screenshot. No tensor is logged or emitted.
   let dry;
   try{dry=await s.run({input:new root.ort.Tensor('float32',new Float32Array(3*224*224),[1,3,224,224])});}
   catch(e){
    // Only a closed fixed error family leaves the private worker, and only
    // for this all-zero non-personal synthetic model compatibility probe.
    const message=String(e?.message||'');
    root.__researchCropErrorClass=/unsupported|not implemented|not registered|kernel|opset/i.test(message)?'UNSUPPORTED_KERNEL':
      /memory|allocat|grow/i.test(message)?'MEMORY':
      /tensor|input|dimension|shape/i.test(message)?'INPUT_TENSOR':
      /wasm|backend|runtime/i.test(message)?'WASM_BACKEND':'OTHER';
    fail();
   }
   if(dry.output?.data?.length!==15)fail();
   root.__researchCropStage='MODEL_READY';
   return s;
  })();
  return promise;
 }
 function tensor(source,box,width,height){
  if(!box||![box.x1,box.y1,box.x2,box.y2].every(Number.isFinite)||
    box.x1<0||box.y1<0||box.x2>width||box.y2>height||box.x2<=box.x1||box.y2<=box.y1)fail();
  const w=box.x2-box.x1,h=box.y2-box.y1,m=Math.max(w,h);
  if(m<2||m>1600)fail();
  // Published preprocessor: centered RGB gray pad, bilinear 224x224, ImageNet
  // mean/std, CHW float32. No crop or pixel data is ever returned.
  const square=new OffscreenCanvas(224,224),ctx=square.getContext('2d',{alpha:false,willReadFrequently:true});
  if(!ctx)fail();
  ctx.fillStyle='rgb(128,128,128)';ctx.fillRect(0,0,224,224);
  const scale=224/m;
  ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='medium';
  ctx.drawImage(source,box.x1,box.y1,w,h,(224-w*scale)/2,(224-h*scale)/2,w*scale,h*scale);
  const rgba=ctx.getImageData(0,0,224,224).data;
  const plane=224*224,values=new Float32Array(plane*3);
  for(let i=0;i<plane;i++)for(let c=0;c<3;c++)values[c*plane+i]=(rgba[i*4+c]/255-mean[c])/std[c];
  return new root.ort.Tensor('float32',values,[1,3,224,224]);
 }
 async function classify(source,width,height,boxes){
  try{
   if(!source||source.width!==width||source.height!==height||!Number.isSafeInteger(width)||
      !Number.isSafeInteger(height)||width*height>12000000||!Array.isArray(boxes)||boxes.length>96)fail();
   const s=await session();const selected=[];
   for(const box of boxes){
    root.__researchCropStage='PREPROCESS';
    const input=tensor(source,box,width,height);
    root.__researchCropStage='INFERENCE';
    const output=await s.run({input});
    root.__researchCropStage='OUTPUT_VALIDATE';
    const logits=output?.output;
    if(logits?.type!=='float32'||logits.dims?.join(',')!=='1,15'||logits.data?.length!==15||
      [...logits.data].some(x=>!Number.isFinite(x)))fail();
    let max=-Infinity,chosen=0;
    for(let i=0;i<15;i++)if(logits.data[i]>max){max=logits.data[i];chosen=i}
    let sum=0;for(let i=0;i<15;i++)sum+=Math.exp(logits.data[i]-max);
    const confidence=1/sum,type=CLASSES[chosen];
    if(!Number.isFinite(confidence))fail();
    selected.push({box,type,confidence,active:ACTIVE.has(type)&&confidence>=.65});
   }
   root.__researchCropStage='COMPLETE';
   return {complete:true,modelSha256:SHA,results:selected};
  }catch{throw Error(ERROR)}
 }
 root.CaptainResearchCropClassifier=Object.freeze({modelSha256:SHA,classify});
})(globalThis);
