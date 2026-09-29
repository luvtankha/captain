import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { cdp, debugJson, evaluate, extensionPath, findSession } from './reload-in-place.mjs';

const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const url=process.argv[2] || 'https://github.com/login';
assert.ok(['https://github.com/login','https://www.wikipedia.org/'].includes(url),'Use a public audit target.');
const version=await debugJson('/json/version');
const installed=await cdp(version.webSocketDebuggerUrl,'Extensions.getExtensions');
const extension=installed.extensions.find(item=>item.path?.toLowerCase()===extensionPath.toLowerCase());
assert.ok(extension,'Start CAPTAIN first.');
const session=await findSession(extension.id);
const state=await evaluate(session.controller,"chrome.runtime.sendMessage({type:'GET_STATE'})");
assert.ok(!['running','waiting_privacy_consent','waiting_human'].includes(state.status),'Finish the active task first.');
const tab=await evaluate(session.controller,`chrome.tabs.create({url:${JSON.stringify(url)},active:true,windowId:${session.windowId || state.session?.windowId || 'undefined'}})`);
assert.equal(tab.incognito,false);
let page;
for(let n=0;n<100;n++) {
  const target=await evaluate(session.controller,`chrome.debugger.getTargets().then(items=>items.find(item=>item.tabId===${tab.id})?.id)`);
  page=(await debugJson('/json/list')).find(item=>item.id===target);
  if(page && await evaluate(page,"document.readyState==='complete'&&!!document.querySelector('#captain-agent-host')").catch(()=>false)) break;
  await pause(200);
}
assert.ok(page,'Live site unavailable.');
await cdp(page.webSocketDebuggerUrl,'Emulation.setFocusEmulationEnabled',{enabled:true});
await cdp(page.webSocketDebuggerUrl,'Runtime.evaluate',{expression:'document.activeElement?.blur()',userGesture:true});
const key=type=>cdp(page.webSocketDebuggerUrl,'Input.dispatchKeyEvent',{type,key:'e',code:'KeyE',windowsVirtualKeyCode:69});
await key('rawKeyDown'); await pause(3900);
assert.equal(await evaluate(page,"getComputedStyle(document.querySelector('#captain-agent-host')).display"),'none');
await pause(200); await key('keyUp');
let result;
for(let n=0;n<100;n++) {
  result=await evaluate(page,`(()=>{
    const host=document.querySelector('#captain-agent-host'),root=host.shadowRoot;
    const canvas=root.querySelector('.preview-canvas'),ctx=canvas.getContext('2d');
    const rect=host.getBoundingClientRect();
    const markers=[...root.querySelectorAll('.privacy-marker')].map(el=>{const r=el.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,color:getComputedStyle(el).backgroundColor}});
    const pixel=(x,y)=>[...ctx.getImageData(Math.floor(x*canvas.width/innerWidth),Math.floor(y*canvas.height/innerHeight),1,1).data];
    const fields=[...document.querySelectorAll('input')].filter(el=>['login','password'].includes(el.name)).map(el=>{const r=el.getBoundingClientRect();return {name:el.name,black:pixel(r.x+r.width/2,r.y+r.height/2).slice(0,3).every(v=>v===0)}});
    return {visible:getComputedStyle(host).display,position:{x:rect.x,y:rect.y,width:rect.width,height:rect.height},ready:!canvas.hidden&&canvas.width>300,phase:root.querySelector('.phase')?.textContent,note:root.querySelector('.preview-note').textContent,markers,fields,publicPixel:pixel(innerWidth-20,80),canvas:{width:canvas.width,height:canvas.height}};
  })()`);
  if(result.ready) break;
  await pause(200);
}
await mkdir(new URL('../runtime/',import.meta.url),{recursive:true});
const name=url.includes('github')?'github':'wikipedia';
const capture=await cdp(page.webSocketDebuggerUrl,'Page.captureScreenshot',{format:'png'});
await writeFile(new URL(`../runtime/local-fields-${name}.png`,import.meta.url),Buffer.from(capture.data,'base64'));
await writeFile(new URL(`../runtime/local-fields-${name}.json`,import.meta.url),JSON.stringify({url,testedAt:new Date().toISOString(),...result},null,2));
console.log(JSON.stringify(result));
assert.ok(result.ready,'Automatic local preview must render.');
assert.equal(result.position.x,8);assert.equal(result.position.y,8);assert.equal(result.position.width,366);
assert.match(result.note,/local only, not sent/);
assert.ok(result.publicPixel.slice(0,3).some(v=>v>0),'Public page must not be blacked out.');
assert.ok(result.markers.every(m=>m.color==='rgba(250, 204, 21, 0.22)' && m.width*m.height<result.canvas.width*result.canvas.height*.25),'Only small transparent yellow regions.');
if(name==='github') { assert.equal(result.fields.length,2);assert.ok(result.fields.every(f=>f.black));assert.ok(result.markers.length>=2); }
else assert.equal(result.markers.length,0,'Public search page is not sensitive.');
console.log('PASS: four-second activation, automatic field-only screenshot, yellow webpage markers, public pixels preserved.');
