import { cdp, debugJson, evaluate, extensionPath, findSession } from './reload-in-place.mjs';
import { sanitizeObservation } from '../server/outbound-contract.mjs';

const safeContractFailure = error => {
  const message = String(error?.message || '');
  const match = /^Outbound contract rejected ([A-Za-z0-9_.\[\]]{1,160}): ([a-z-]{2,40}(?: [a-z-]{2,40}){0,4})$/.exec(message);
  const missing = /^Cannot read properties of (?:undefined|null) \(reading '([A-Za-z]{1,80})'\)$/.exec(message);
  const frame = String(error?.stack || '').split('\n').map(line => /outbound-contract\.mjs:(\d+):(\d+)/.exec(line)).find(Boolean);
  return match ? { code: error.code || 'CAPTAIN_OUTBOUND_CONTRACT', path: match[1], reason: match[2] } : {
    code: 'UNCLASSIFIED',
    errorName: /^[A-Za-z]{1,40}$/.test(String(error?.name || '')) ? error.name : 'Error',
    messageLength: message.length,
    ...(missing?.[1] ? { missingProperty: missing[1] } : {}),
    ...(error?.name === 'TypeError' && /^[A-Za-z0-9 .,'()_-]{1,160}$/.test(message) &&
      !/(?:@|https?|\b\d[ -]*\d[ -]*\d[ -]*\d[ -]*\d[ -]*\d[ -]*\d[ -]*\d[ -]*\d[ -]*\d\b)/i.test(message)
      ? { runtimeMessage: message } : {}),
    ...(frame ? { contractFrame: Number(frame[1]) } : {}),
    ...(Number(frame?.[1]) === 19 ? { contractMessage: message } : {}),
  };
};
const outboundProjection = context => {
  const projected = structuredClone(context);
  delete projected.redactionBoxes;
  projected.viewport = {
    width: projected.viewport?.width,
    height: projected.viewport?.height,
    devicePixelRatio: projected.viewport?.devicePixelRatio,
  };
  projected.pageMetadata = Object.fromEntries([
    'domFingerprint', 'visibleTextHash', 'elementCount', 'meaningfulContent', 'capturedAt',
  ].filter(key => Object.hasOwn(projected.pageMetadata || {}, key)).map(key => [key, projected.pageMetadata[key]]));
  projected.vision = { ...projected.vision, status: 'visual-disabled', rawScreenshotTransmitted: false };
  return projected;
};

// Local diagnostics only: counts, never page text or field values.
const version = await debugJson('/json/version');
const installed = await cdp(version.webSocketDebuggerUrl, 'Extensions.getExtensions');
const extension = installed.extensions.find(item => item.path?.toLowerCase() === extensionPath.toLowerCase());
const { controller } = await findSession(extension.id);
const report = await evaluate(controller, `
  (async () => {
    const state = await chrome.runtime.sendMessage({type:'GET_STATE'});
    const tabId = state.session?.tabId;
    const observed=${process.argv.includes('--observe') ? "(['running','waiting_human','waiting_privacy_consent'].includes(state.status)) ? null : await chrome.tabs.sendMessage(tabId,{type:'OBSERVE',captureRequested:true})" : 'null'};
    const page = await chrome.scripting.executeScript({target:{tabId},func:()=>{
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let textNodes = 0, visibleText = 0, node;
      while ((node=walker.nextNode())) {
        textNodes++;
        const p=node.parentElement, r=p?.getBoundingClientRect();
        if (r?.width>2 && r.height>2 && r.bottom>=0 && r.top<=innerHeight && node.nodeValue.trim()) visibleText++;
      }
      return {scan:globalThis.__captainPageController?.scanStatus?.(),host:location.hostname,styled:document.querySelectorAll('*').length,textNodes,visibleText,
        largestParagraph:Math.max(0,...[...document.querySelectorAll('h1,h2,h3,p,th,td,label')].map(e=>(e.innerText||e.textContent||'').length))};
    }}).then(r=>r[0]?.result);
    const typeCounts={};
    for(const item of observed?.sensitiveRegions||[]){
      const type=typeof item?.type==='string'&&/^[A-Z_]{1,48}$/.test(item.type)?item.type:'INVALID';
      typeCounts[type]=(typeCounts[type]||0)+1;
    }
    return {status:state.status,phase:state.phase,visualStage:state.visualStage,
      observed:observed?{sensitiveRegionCount:(observed.sensitiveRegions||[]).length,sensitiveTypeCounts:typeCounts,elementCount:(observed.elements||[]).length}:null,...page};
  })()
`);
if (process.argv.includes('--contract')) {
  // This stays in the local diagnostic process: it receives the already
  // content-script-sanitized observation only to exercise the same strict
  // companion schema. It prints no page text, field values, box coordinates,
  // screenshot or URL query.
  const observed = await evaluate(controller, `
    (async()=>{
      const state=await chrome.runtime.sendMessage({type:'GET_STATE'});
      if(['running','waiting_human','waiting_privacy_consent'].includes(state.status))throw new Error('Task active');
      return chrome.tabs.sendMessage(state.session?.tabId,{type:'OBSERVE',captureRequested:false});
    })()
  `);
  try {
    sanitizeObservation({ task: 'open stackoverflow.com', context: outboundProjection(observed), history: [] });
    report.contract = { passed: true };
  } catch (error) {
    report.contract = { passed: false, ...safeContractFailure(error) };
  }
}
console.log(report);
