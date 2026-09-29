// ISOLATED RESEARCH ONLY. Removed together with /controls/research from both
// shipping packages. Never used by production screenshot, planner or actions.
// Community ONNX conversion's model lineage/license remains unverified.
(function (root) {
  'use strict';
  const SHA = 'ee3cb8e8f527b1f2a18e9553d03dc8a08de21bd8b5423a505dc014c8d107f2d0';
  const LENGTH=3226312,SIDE=640,CONFIDENCE=0.35,IOU=0.45;
  let runtime;
  const overlap=(a,b)=>{const inter=Math.max(0,Math.min(a.x2,b.x2)-Math.max(a.x1,b.x1))*
    Math.max(0,Math.min(a.y2,b.y2)-Math.max(a.y1,b.y1));
    const union=(a.x2-a.x1)*(a.y2-a.y1)+(b.x2-b.x1)*(b.y2-b.y1)-inter;
    return union>0?inter/union:0;};
  const ready=async()=>{
    if(runtime)return runtime;
    const url=new URL('controls/experiments/omniparser-community-int8.onnx',self.location.href);
    if(url.protocol!==self.location.protocol||url.host!==self.location.host)throw Error('Research model unavailable');
    const response=await fetch(url.href);
    if(!response.ok)throw Error('Research model unavailable');
    const bytes=await response.arrayBuffer();
    if(bytes.byteLength!==LENGTH)throw Error('Research model unavailable');
    const sha=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))]
      .map(x=>x.toString(16).padStart(2,'0')).join('');
    if(sha!==SHA)throw Error('Research model unavailable');
    runtime=await ort.InferenceSession.create(new Uint8Array(bytes),
      {executionProviders:['wasm'],graphOptimizationLevel:'all'});
    if(runtime.inputNames?.join(',')!=='images'||runtime.outputNames?.join(',')!=='output0')throw Error('Research model unavailable');
    return runtime;
  };
  async function detect(bitmap){
    if(!bitmap||!Number.isSafeInteger(bitmap.width)||!Number.isSafeInteger(bitmap.height)||
      bitmap.width<1||bitmap.height<1||bitmap.width*bitmap.height>12000000)throw Error('Research model unavailable');
    const model=await ready();
    const w=bitmap.width,h=bitmap.height,scale=Math.min(SIDE/w,SIDE/h);
    const dw=Math.round(w*scale),dh=Math.round(h*scale);
    const ox=Math.floor((SIDE-dw)/2),oy=Math.floor((SIDE-dh)/2);
    const canvas=new OffscreenCanvas(SIDE,SIDE),ctx=canvas.getContext('2d',{alpha:false,willReadFrequently:true});
    if(!ctx)throw Error('Research model unavailable');
    ctx.fillStyle='#727272';ctx.fillRect(0,0,SIDE,SIDE);
    ctx.drawImage(bitmap,0,0,w,h,ox,oy,dw,dh);
    const rgba=ctx.getImageData(0,0,SIDE,SIDE).data,plane=SIDE*SIDE;
    if(rgba.length!==plane*4)throw Error('Research model unavailable');
    const vals=new Float32Array(plane*3);
    for(let i=0;i<plane;i++){vals[i]=rgba[4*i]/255;vals[plane+i]=rgba[4*i+1]/255;vals[2*plane+i]=rgba[4*i+2]/255;}
    const outputs=await model.run({images:new ort.Tensor('float32',vals,[1,3,SIDE,SIDE])});
    const t=outputs.output0,n=t?.dims?.[2],data=t?.data;
    if(t?.type!=='float32'||t?.dims?.join(',')!=='1,5,8400'||data?.length!==42000)throw Error('Research model unavailable');
    const candidates=[];
    for(let i=0;i<n;i++){
      const score=data[4*n+i];if(!Number.isFinite(score))throw Error('Research model unavailable');
      if(score<CONFIDENCE)continue;
      const x=data[i],y=data[n+i],rw=data[2*n+i],rh=data[3*n+i];
      if(![x,y,rw,rh].every(Number.isFinite)||rw<=0||rh<=0)continue;
      candidates.push({confidence:score,box:{x1:(x-rw/2-ox)/scale,y1:(y-rh/2-oy)/scale,
        x2:(x+rw/2-ox)/scale,y2:(y+rh/2-oy)/scale}});
      if(candidates.length>1024)throw Error('Research model unavailable');
    }
    candidates.sort((a,b)=>b.confidence-a.confidence);
    const boxes=[];
    for(const item of candidates){if(boxes.every(k=>overlap(k,item.box)<IOU)){
      boxes.push(item.box);if(boxes.length>128)throw Error('Research model unavailable');
    }}
    return {boxes,modelSha256:SHA};
  }
  root.CaptainUICandidateResearch=Object.freeze({detect,sha256:SHA});
})(globalThis);
