import { cdp, debugJson, evaluate, extensionPath, findSession } from './reload-in-place.mjs';

try {
  const version = await debugJson('/json/version');
  const installed = await cdp(version.webSocketDebuggerUrl, 'Extensions.getExtensions');
  const extension = installed.extensions.find(item => item.path?.toLowerCase() === extensionPath.toLowerCase());
  if (!extension) throw new Error('CAPTAIN project extension is not installed. Run npm run demo first.');
  const session = await findSession(extension.id);
  if (!session) throw new Error('No CAPTAIN normal-tab controller is open. Run npm run demo first.');
  const value = await evaluate(session.controller, `(async()=>{
    const controller=await chrome.tabs.getCurrent();
    if(!controller||controller.incognito)throw new Error('CAPTAIN controller is not in a normal tab.');
    const state=await chrome.runtime.sendMessage({type:'GET_STATE'});
    let tab=null;
    if(state.session?.connected && state.session.tabId)try{tab=await chrome.tabs.get(state.session.tabId);}catch{}
    const connected=!!tab&&!tab.incognito&&tab.windowId===controller.windowId&&tab.id!==controller.id;
    return {
      commandStatus:document.querySelector('#command-status')?.textContent,state,
      connected,message:connected?state.session.message:state.session?.message||'No connected working tab; the next command will create one.',
      tab:connected?{id:tab.id,windowId:tab.windowId,incognito:tab.incognito,url:tab.url}:null,
      window:await chrome.windows.get(controller.windowId),
      tabs:(await chrome.tabs.query({windowId:controller.windowId})).map(t=>({id:t.id,active:t.active,status:t.status})),
      controllerId:controller.id,controllerWindow:(await chrome.windows.getCurrent()).type
    };
  })()`);
  console.log(JSON.stringify(value, null, 2));
} catch (error) {
  console.error(JSON.stringify({ connected: false, error: error.message }));
  process.exitCode = 1;
}
