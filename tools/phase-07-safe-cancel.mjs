// Cancel only the existing CAPTAIN private task; never navigate or close tabs.
import assert from 'node:assert/strict';
import {debugJson,cdp,evaluate,extensionPath,findSession} from './reload-in-place.mjs';
const b=await debugJson('/json/version');
const e=await cdp(b.webSocketDebuggerUrl,'Extensions.getExtensions');
const extension=e.extensions.find(x=>x.path?.toLowerCase()===extensionPath.toLowerCase());
assert.ok(extension?.id);
const session=await findSession(extension.id);
assert.ok(session?.controller&&session.windowId);
const result=await evaluate(session.controller,`(async()=>{
  const owner=await chrome.tabs.getCurrent();
  if(!owner?.incognito||owner.windowId!==${session.windowId})throw Error('Wrong controller');
  const current=await chrome.runtime.sendMessage({type:'GET_STATE'});
  if(current.status!=='running')return {wasRunning:false};
  const cancel=await chrome.runtime.sendMessage({type:'CANCEL_TASK'});
  return {wasRunning:true,cancelAccepted:cancel?.ok===true};
})()`);
console.log(JSON.stringify(result));
