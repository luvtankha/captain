// Experimental, zero-weight, strictly IMAGE-ONLY rectangle proposal baseline.
// This is classical computer vision, NOT a pretrained semantic UI model.
// It sees only screenshot pixels and produces no text, selectors or cN refs.
// Research-only Phase-8 evaluation; production still uses its pinned ONNX
// model and exact existing fail-closed fusion/privacy gate.
(function(root){
 'use strict';
 const MAX=2_000_000, MAX_BOXES=96, THRESH=52;
 const finite=n=>typeof n==='number'&&Number.isFinite(n);
 const fail=()=>{throw Error('Image rectangle inference unavailable.');};
 function detect(pixels,width,height){
  if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<40||height<40||
      width*height>MAX||pixels?.length!==width*height*4)fail();
  const total=width*height,edge=new Uint8Array(total),grown=new Uint8Array(total),seen=new Uint8Array(total);
  // Two-pixel color discontinuity is robust to the antialiased one-pixel
  // borders of rectangular inputs/buttons but excludes uniform text areas.
  for(let y=2;y<height-2;y++)for(let x=2;x<width-2;x++){
   const i=y*width+x,p=i*4;
   const a=(p-8),b=(p+8),c=(p-width*8),d=(p+width*8);
   const dx=Math.abs(pixels[a]-pixels[b])+Math.abs(pixels[a+1]-pixels[b+1])+
      Math.abs(pixels[a+2]-pixels[b+2]);
   const dy=Math.abs(pixels[c]-pixels[d])+Math.abs(pixels[c+1]-pixels[d+1])+
      Math.abs(pixels[c+2]-pixels[d+2]);
   if(dx>=THRESH||dy>=THRESH)edge[i]=1;
  }
  // A single dilation joins rounded corners and one-pixel border gaps.
  for(let y=2;y<height-2;y++)for(let x=2;x<width-2;x++){
   const i=y*width+x;
   if(!edge[i])continue;
   for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++)grown[i+dy*width+dx]=1;
  }
  const regions=[];
  for(let y=3;y<height-3;y++)for(let x=3;x<width-3;x++){
   const start=y*width+x;
   if(!grown[start]||seen[start])continue;
   let left=x,right=x,top=y,bottom=y,count=0;
   const queue=[start];seen[start]=1;
   for(let pos=0;pos<queue.length;pos++){
    const v=queue[pos],xx=v%width,yy=(v-xx)/width;
    count++;left=Math.min(left,xx);right=Math.max(right,xx);
    top=Math.min(top,yy);bottom=Math.max(bottom,yy);
    // A noisy image/raster has no trustworthy rectangle proposal; discard the
    // oversized component instead of returning an uncontrolled huge result.
    if(count>150000)break;
    for(const next of [v-1,v+1,v-width,v+width]){
     if(next<0||next>=total||seen[next]||!grown[next])continue;
     if(Math.abs(next%width-xx)>1)continue;
     seen[next]=1;queue.push(next);
    }
   }
   const w=right-left+1,h=bottom-top+1;
   if(count>150000||w<18||h<22||w>650||h>100||w/h<.36||w/h>22)continue;
   // At least half the top/bottom and a third of the sides must contain
   // IMAGE edges: text clusters and textured photos should not count as UI.
   const line=(horizontal,coordinate,lo,hi)=>{
    let n=0,den=0;
    for(let t=lo+3;t<hi-3;t++){
     den++;
     const at=horizontal?coordinate*width+t:t*width+coordinate;
     if(edge[at]||edge[at-width]||edge[at+width]||edge[at-1]||edge[at+1])n++;
    }
    return den>0?n/den:0;
   };
   const sides=[line(true,top,left,right),line(true,bottom,left,right),
    line(false,left,top,bottom),line(false,right,top,bottom)];
   if(sides[0]<.48||sides[1]<.48||sides[2]<.28||sides[3]<.28)continue;
   const score=Math.min(...sides);
   const box={x1:Math.max(0,left-1),y1:Math.max(0,top-1),
     x2:Math.min(width,right+2),y2:Math.min(height,bottom+2)};
   if(!Object.values(box).every(finite))fail();
   regions.push({box,confidence:Math.round(score*1000)/1000});
   if(regions.length>MAX_BOXES)fail();
  }
  return regions;
 }
 root.CaptainUIImageShape=Object.freeze({detect});
})(globalThis);
