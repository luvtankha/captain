import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { cdp, debugJson, evaluate, extensionPath, findNormalWorker, findSession } from './reload-in-place.mjs';
import { payloadLeaks } from '../server/privacy.mjs';

const percent = (part, total) => total ? Number((part * 100 / total).toFixed(2)) : 0;
const rectArea = box => Math.max(0, box.width) * Math.max(0, box.height);
const intersectionArea = (a, b) => Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
function detectionScore(expected, predicted) {
  const available = new Set(predicted.map((_, index) => index)); let matched = 0;
  for (const truth of expected) {
    let best = -1, bestOverlap = 0;
    for (const index of available) {
      const candidate = predicted[index]; if (candidate.kind !== truth.kind) continue;
      const overlap = intersectionArea(truth, candidate) / Math.max(1, Math.min(rectArea(truth), rectArea(candidate)));
      if (overlap > bestOverlap) { best = index; bestOverlap = overlap; }
    }
    if (best >= 0 && bestOverlap >= 0.5) { available.delete(best); matched++; }
  }
  const precision = percent(matched, predicted.length), recall = percent(matched, expected.length);
  return { expected: expected.length, detected: predicted.length, matched, falsePositives: predicted.length - matched, falseNegatives: expected.length - matched, precisionPercent: precision, recallPercent: recall, f1Percent: precision + recall ? Number((2 * precision * recall / (precision + recall)).toFixed(2)) : 0 };
}
function redactionScore(expected, predicted, width, height) {
  const mask = new Uint8Array(width * height);
  const paint = (boxes, bit) => boxes.forEach(box => {
    const x1 = Math.max(0, Math.floor(box.x)), y1 = Math.max(0, Math.floor(box.y));
    const x2 = Math.min(width, Math.ceil(box.x + box.width)), y2 = Math.min(height, Math.ceil(box.y + box.height));
    for (let y = y1; y < y2; y++) for (let x = x1; x < x2; x++) mask[y * width + x] |= bit;
  });
  paint(expected, 1); paint(predicted, 2);
  let expectedPixels = 0, redactedPixels = 0, truePositivePixels = 0;
  for (const value of mask) { if (value & 1) expectedPixels++; if (value & 2) redactedPixels++; if (value === 3) truePositivePixels++; }
  const precision = percent(truePositivePixels, redactedPixels), recall = percent(truePositivePixels, expectedPixels);
  const perRegion = expected.map(box => {
    const x1 = Math.max(0, Math.floor(box.x)), y1 = Math.max(0, Math.floor(box.y));
    const x2 = Math.min(width, Math.ceil(box.x + box.width)), y2 = Math.min(height, Math.ceil(box.y + box.height));
    let pixels = 0, painted = 0;
    for (let y = y1; y < y2; y++) for (let x = x1; x < x2; x++) {
      pixels++; if (mask[y * width + x] & 2) painted++;
    }
    return { kind: box.kind, expectedPixels: pixels, maskedPixels: painted,
      maskedPercent: percent(painted, pixels) };
  });
  return { method: 'CSS-pixel mask overlap', expectedPixels, redactedPixels, truePositivePixels, precisionPercent: precision, recallPercent: recall, f1Percent: precision + recall ? Number((2 * precision * recall / (precision + recall)).toFixed(2)) : 0, perRegion };
}
function cpuPercent(before, after, elapsedMs) {
  const start = new Map(before.map(item => [item.id, item.cpuTime]));
  const cpuSeconds = after.reduce((sum, item) => sum + (start.has(item.id) ? Math.max(0, item.cpuTime - start.get(item.id)) : 0), 0);
  return { matchedProcessCpuSeconds: Number(cpuSeconds.toFixed(4)), elapsedMs: Math.round(elapsedMs), aggregatePercentOfOneCore: Number((cpuSeconds * 100000 / elapsedMs).toFixed(2)) };
}
function chromeWorkingSetMiB(processes) {
  const ids = processes.map(item => Number(item.id)).filter(Number.isInteger);
  if (!ids.length || process.platform !== 'win32') return null;
  try {
    const command = `$ids=@(${ids.join(',')});$sum=(Get-Process | Where-Object {$ids -contains $_.Id} | Measure-Object -Property WorkingSet64 -Sum).Sum;if($null -eq $sum){0}else{[math]::Round($sum/1MB,2)}`;
    return Number(execFileSync('powershell.exe', ['-NoProfile', '-Command', command], { encoding: 'utf8', timeout: 5000 }).trim());
  } catch { return null; }
}

const privacyOnly = process.argv.includes('--privacy-only');
const fixtureVariant = process.argv.includes('--dark') ? 'dark' :
  process.argv.includes('--zoom125') ? 'zoom125' :
  process.argv.includes('--zoom75') ? 'zoom75' : 'base';
assert.ok(process.argv.filter(arg => ['--dark','--zoom125','--zoom75'].includes(arg)).length <= 1,
  'Choose at most one synthetic fixture variant.');
const report = { started: new Date().toISOString(), fixture: 'synthetic-local',
  variant: fixtureVariant, mode: privacyOnly ? 'privacy-pixel-metrics-only' : 'full-original-audit', assertions: {} };
try {
  const benchmarkStarted = performance.now();
  const version = await debugJson('/json/version');
  const processStart = (await cdp(version.webSocketDebuggerUrl, 'SystemInfo.getProcessInfo')).processInfo;
  const installed = await cdp(version.webSocketDebuggerUrl, 'Extensions.getExtensions');
  const extension = installed.extensions.find(item => item.path?.toLowerCase() === extensionPath.toLowerCase());
  assert.ok(extension, 'CAPTAIN extension is not installed');
  const session = await findSession(extension.id); assert.ok(session, 'CAPTAIN controller is not open');
  const privateWorker = await findNormalWorker(extension.id, session.windowId); assert.ok(privateWorker, 'CAPTAIN normal service worker is not available');
  const companionToken = await evaluate(session.controller,
    `chrome.storage.session.get({captainCompanionToken:''}).then(x=>x.captainCompanionToken)`);
  assert.match(companionToken, /^[a-f0-9]{64}$/, 'CAPTAIN companion authentication is unavailable');
  const extensionOrigin = `chrome-extension://${extension.id}`;
  const expectedBuild = JSON.parse(await readFile(new URL('../extension/manifest.json', import.meta.url), 'utf8')).version;
  const result = await evaluate(privateWorker.worker, `(async()=>{
    const controller={id:${session.controllerTabId},windowId:${session.windowId}};
    const key='captainWindow:'+controller.windowId;
    let binding=(await chrome.storage.session.get(key))[key],tab;
    try{if(binding?.tabId)tab=await chrome.tabs.get(binding.tabId)}catch{}
    if(!tab||tab.incognito||tab.windowId!==controller.windowId||tab.url.startsWith(chrome.runtime.getURL(''))){tab=await chrome.tabs.create({windowId:controller.windowId,url:'about:blank',active:true});await chrome.storage.session.set({[key]:{tabId:tab.id,windowId:tab.windowId}})}
    await chrome.tabs.update(tab.id,{active:true,url:'http://127.0.0.1:4317/privacy-fixture.html'});
    const browserWindow=await chrome.windows.get(controller.windowId);
    await chrome.windows.update(controller.windowId,browserWindow.state==='minimized'?{state:'normal',focused:true}:{focused:true});
    const deadline=Date.now()+20000;
    do{await new Promise(r=>setTimeout(r,200));tab=await chrome.tabs.get(tab.id);if(tab.status==='complete'&&!tab.pendingUrl)break}while(Date.now()<deadline);
    await new Promise(r=>setTimeout(r,800));
    // Test-only, exact localhost fixture variants. Capture and page-owned labels
    // are collected AFTER mutation; no screenshot/text is returned to Node.
    const variant=${JSON.stringify(fixtureVariant)};
    if(variant!=='base'){
      const changed=await chrome.scripting.executeScript({target:{tabId:tab.id},func:v=>{
        if(location.origin!=='http://127.0.0.1:4317'||location.pathname!=='/privacy-fixture.html')return false;
        if(v==='dark'){
          document.body.style.background='#111827';document.body.style.color='#f9fafb';
          const main=document.querySelector('main');if(!main)return false;
          main.style.background='#172033';main.style.color='#f9fafb';
          return true;
        }
        if(v==='zoom125'||v==='zoom75'){
          document.documentElement.style.zoom=v==='zoom125'?'125%':'75%';return true;
        }
        return false;
      },args:[variant]});
      if(changed?.[0]?.result!==true)throw Error('Synthetic fixture variant refused');
      await new Promise(r=>setTimeout(r,250));
    }
    const groundTruth=(await chrome.scripting.executeScript({target:{tabId:tab.id},func:()=>{const rect=node=>{const r=node.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,kind:node.dataset.captainPrivate||''}};return{sensitive:[...document.querySelectorAll('[data-captain-private]')].map(rect),safeText:[...document.querySelectorAll('[data-captain-safe]')].map(node=>node.textContent.trim()),safeBoxes:[...document.querySelectorAll('[data-captain-safe]')].map(rect),ui:[...document.querySelectorAll('[data-captain-ui]')].map(node=>node.tagName==='INPUT'?'input:'+(node.type||'text'):node.tagName.toLowerCase()+':'+node.textContent.trim())}}}))[0].result;
    // Match production's strict capture gate; the prior DOM-only observation
    // omitted the conservative screenshot-specific address/block mask.
    const context=await chrome.tabs.sendMessage(tab.id,{type:'OBSERVE',captureRequested:true});
    let raw,lastCaptureError,captureMethod='captureVisibleTab',panelHideRequested=false;
    // Mirror the production capture boundary exactly: CAPTAIN's own floating
    // panel is hidden only for the raw capture, then restored before any
    // visual worker processing. Its transient labels must not become OCR input
    // or make a page appear less useful than the real extension workflow.
    try{
      panelHideRequested=true;
      const hidden=await chrome.tabs.sendMessage(tab.id,{type:'CAPTURE_PANEL',mode:'hide'});
      if(hidden?.ok!==true)throw new Error('CAPTAIN panel could not be hidden for visual audit');
      for(let attempt=0;attempt<3;attempt++){try{await chrome.windows.update(controller.windowId,{focused:true});await chrome.tabs.update(tab.id,{active:true});await new Promise(r=>setTimeout(r,400*(attempt+1)));raw=await chrome.tabs.captureVisibleTab(controller.windowId,{format:'jpeg',quality:82});break}catch(error){lastCaptureError=error;if(!/image readback failed/i.test(error.message||''))throw error}}
      if(!raw&&/image readback failed/i.test(lastCaptureError?.message||'')){const debuggee={tabId:tab.id};await chrome.debugger.attach(debuggee,'1.3');try{const shot=await chrome.debugger.sendCommand(debuggee,'Page.captureScreenshot',{format:'jpeg',quality:82,fromSurface:true});raw='data:image/jpeg;base64,'+shot.data;captureMethod='debugger-fallback'}finally{await chrome.debugger.detach(debuggee)}}
    }finally{
      if(panelHideRequested){const restored=await chrome.tabs.sendMessage(tab.id,{type:'CAPTURE_PANEL',mode:'restore'}).catch(()=>null);if(restored?.ok!==true)throw new Error('CAPTAIN panel could not be restored after visual audit')}
    }
    if(!raw)throw lastCaptureError||new Error('Visual capture failed');
    const hostUrl=chrome.runtime.getURL('offscreen.html');
    const hosts=incognito=>chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT'],documentUrls:[hostUrl],incognito});
    if((await hosts(true)).length)throw new Error('Incognito visual host refused');
    if(!(await hosts(false)).length)await chrome.offscreen.createDocument({url:'offscreen.html',
      reasons:['WORKERS','BLOBS'],justification:'Private synthetic visual privacy audit'});
    if((await hosts(false)).length!==1)throw new Error('Normal visual host unavailable');
    // Mirror production's local-only UI lease/geometry projection. Omitting
    // this snapshot makes the enabled UI fusion correctly full-blackout;
    // that would measure a malformed audit request, not the product pipeline.
    const meta=context.pageMetadata||{};
    const lease={documentToken:meta.documentToken,observationId:meta.observationId,
      domRevision:meta.domRevision,geometryRevision:meta.geometryRevision};
    const uiSnapshot={lease,controls:(context.elements||[]).slice(0,250).map(element=>({
      ref:element.ref,box:element.bbox,source:element.source,visible:element.visible,
      enabled:element.enabled,sensitive:element.sensitive,lease}))};
    const visual=await chrome.runtime.sendMessage({type:'VISION_REDACT',visionHost:'offscreen',windowId:controller.windowId,screenshot:raw,viewport:context.viewport,redactionBoxes:context.redactionBoxes,uiSnapshot,auditGateOnly:true});
    // Raw pixels remain in this trusted private worker and are never returned
    // to Node. Independently compare raw and sanitized JPEG over page-labelled
    // PUBLIC control/text boxes, returning only aggregate changed-pixel counts.
    const decode=async data=>{
      const bytes=Uint8Array.from(atob(data.split(',')[1]),c=>c.charCodeAt(0));
      return createImageBitmap(new Blob([bytes],{type:'image/jpeg'}));
    };
    if(visual?.ok!==true||typeof visual.screenshot!=='string')throw Error('Sanitized image unavailable');
    const [before,after]=await Promise.all([decode(raw),decode(visual.screenshot)]);
    let publicPixelPreservation;
    try{
      if(before.width!==after.width||before.height!==after.height)throw Error('Sanitized dimensions differ');
      const pixels=bitmap=>{const c=new OffscreenCanvas(bitmap.width,bitmap.height),x=c.getContext('2d',{willReadFrequently:true});x.drawImage(bitmap,0,0);return x.getImageData(0,0,bitmap.width,bitmap.height).data};
      const a=pixels(before),b=pixels(after),sx=before.width/context.viewport.width,sy=before.height/context.viewport.height;
      let sampled=0,changed=0;
      const regions=[];
      for(const [index,box] of groundTruth.safeBoxes.entries()){
        const x0=Math.max(0,Math.ceil(box.x*sx)+4),x1=Math.min(before.width,Math.floor((box.x+box.width)*sx)-4);
        const y0=Math.max(0,Math.ceil(box.y*sy)+4),y1=Math.min(before.height,Math.floor((box.y+box.height)*sy)-4);
        if(x1<=x0||y1<=y0)throw Error('Public fixture label has no image interior');
        let regionSampled=0,regionChanged=0;
        for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++){
          const i=(y*before.width+x)*4;sampled++;regionSampled++;
          if(Math.abs(a[i]-b[i])+Math.abs(a[i+1]-b[i+1])+Math.abs(a[i+2]-b[i+2])>48){changed++;regionChanged++}
        }
        // The index identifies a deliberately public local-fixture region;
        // no page text, screenshot pixels or sensitive geometry leave here.
        regions.push({fixturePublicRegion:index+1,sampledPixels:regionSampled,
          changedBeyondJpegTolerance:regionChanged,
          changedPercent:Math.round(10000*regionChanged/regionSampled)/100});
      }
      publicPixelPreservation={method:'private-worker-labelled-public-JPEG-comparison',
        labelledRegions:groundTruth.safeBoxes.length,sampledPixels:sampled,
        changedBeyondJpegTolerance:changed,changedPercent:Math.round(10000*changed/sampled)/100,regions};
    }finally{before.close();after.close()}
    globalThis.__captainSanitizedAudit=visual?.screenshot||'';
    const {screenshot,...visualMeta}=visual||{};
    return {build:chrome.runtime.getManifest().version,tabId:tab.id,windowId:tab.windowId,url:tab.url,captureMethod,groundTruth,context,visual:visualMeta,publicPixelPreservation,rawLength:raw.length,sanitizedLength:screenshot?.length||0,sanitizedDiffers:screenshot!==raw};
  })()`);
  assert.equal(result.build, expectedBuild, 'Extension build is stale');
  assert.equal(result.url, 'http://127.0.0.1:4317/privacy-fixture.html');
  assert.equal(result.visual.ok, true, result.visual.error || 'Local visual worker failed');
  assert.equal(result.visual.visualPrivacy.sanitized, true);
  assert.equal(result.visual.visualPrivacy.rawScreenshotTransmitted, false);
  assert.equal(result.visual.visualPrivacy.schema, 'captain.visual-privacy.v2');
  assert.equal(result.visual.visualPrivacy.maskPolicy, 'opaque-raster-v1');
  assert.ok(['DOM','OCR','EMPTY','SELECTIVE','ENCODE_BLACKOUT'].includes(result.visual.localAuditGate),
    'Synthetic worker audit reason was not a fixed trusted enum.');
  assert.ok(['UNAVAILABLE','RUNNING','NO_WORDS','REVIEWING','REVIEW_BLACKOUT','REVIEW_SELECTIVE','ALL_WORDS_ALREADY_MASKED',
    'INCOMPLETE','OCR_ERROR','ALTERNATIVE_BLACKOUT','ALTERNATIVE_ERROR'].includes(result.visual.localOcrAudit),
    'Synthetic local OCR diagnostic was not a fixed trusted enum.');
  assert.ok(['NOT_APPLICABLE','EMPTY','LOW_OR_INVALID_CONFIDENCE','UNSUPPORTED_TEXT','INVALID_CONFIDENCE','INVALID_TEXT','GEOMETRY_OR_POLICY']
    .includes(result.visual.localOcrRejectClass));
  assert.ok(['NOT_APPLICABLE','UNAVAILABLE','INVALID_GEOMETRY','COVERED_WORD_IN_MIXED_ROW',
    'PARTIAL_MASK_OVERLAP','OUTSIDE_MASKS','COVERED_AND_PARTIAL',
    'COVERED_AND_OUTSIDE','PARTIAL_AND_OUTSIDE','ALL_THREE','NONE']
    .includes(result.visual.localOcrRejectScope));
  for (const field of ['faceModelLoadMs','faceInferenceMs','ocrAndReviewMs',
    'uiFusionMs','pixelRedactionEncodeAndProofMs'])
    assert.ok(Number.isSafeInteger(result.visual.localStageTimings?.[field]) &&
      result.visual.localStageTimings[field] >= 0 && result.visual.localStageTimings[field] <= 100000,
      'Unexpected private-worker numerical stage timing.');
  assert.equal(result.visual.visualPrivacy.coverageVerified, true);
  assert.ok(Number.isInteger(result.visual.visualPrivacy.pixelMaskCount) && result.visual.visualPrivacy.pixelMaskCount >= 1, 'No verified opaque pixel masks');
  assert.equal(result.sanitizedDiffers, true);
  assert.ok(result.visual.visualPrivacy.domBoxes >= 6, `Expected at least 6 DOM/raster redactions, got ${result.visual.visualPrivacy.domBoxes}`);
  // Face detection is measured, not treated as the only privacy boundary.
  // The current fail-closed policy withholds raster/background surfaces even
  // when UltraFace misses a face; require that independent raster mask here.
  assert.ok(result.context.redactionBoxes.some(box =>
    ['RASTER_CONTENT', 'BACKGROUND_IMAGE'].includes(box.kind)),
  'The synthetic face/raster region was not independently withheld');
  for (const kind of ['EMAIL', 'PHONE', 'PAN', 'ADDRESS', 'PASSWORD', 'CREDENTIAL', 'RASTER_CONTENT'])
    assert.ok(Number(result.context.piiCounts[kind]) >= 1, `Missing ${kind} detection`);
  assert.doesNotMatch(result.context.pageText, /luv\.tankha\.sih@example\.com|9876543210|ABCDE1234F|NeverTransmitThis/);
  const expectedPii = result.groundTruth.sensitive.filter(box => box.kind !== 'BACKGROUND_IMAGE');
  const predictedPii = result.context.redactionBoxes.filter(box => box.kind !== 'BACKGROUND_IMAGE');
  const piiDetection = detectionScore(expectedPii, predictedPii);
  const redaction = redactionScore(result.groundTruth.sensitive, result.context.redactionBoxes, Math.round(result.context.viewport.width), Math.round(result.context.viewport.height));
  const observedUi = result.context.elements.map(element => element.tag === 'input' ? `input:${element.type || 'text'}` : `${element.tag}:${element.name}`);
  const expectedUi = [...result.groundTruth.ui], remainingUi = [...observedUi]; let matchedUi = 0;
  for (const expected of expectedUi) { const index = remainingUi.indexOf(expected); if (index >= 0) { remainingUi.splice(index, 1); matchedUi++; } }
  const matchedSafeText = result.groundTruth.safeText.filter(text => result.context.pageText.includes(text)).length;
  const visualTargets = expectedUi.length + result.groundTruth.safeText.length, matchedVisualTargets = matchedUi + matchedSafeText;
  const visualContext = { expectedTargets: visualTargets, matchedTargets: matchedVisualTargets, extraInteractiveTargets: remainingUi.length, accuracyPercent: percent(matchedVisualTargets, visualTargets), interactivePrecisionPercent: percent(matchedUi, observedUi.length), interactiveRecallPercent: percent(matchedUi, expectedUi.length) };
  let sanitizedScreenshot = '';
  for (let offset = 0; offset < result.sanitizedLength; offset += 250000) {
    sanitizedScreenshot += await evaluate(privateWorker.worker, `globalThis.__captainSanitizedAudit.slice(${offset},${offset + 250000})`);
  }
  // Independently inspect the ACTUAL outgoing JPEG pixels, not merely the
  // DOM mask coordinates or the worker's self-attested coverage boolean.
  // Decode only inside the trusted private service worker and return bounded
  // aggregate geometry counts; no raw screenshot or private OCR is returned.
  const pixelBoxes = result.groundTruth.sensitive.map(({ x, y, width, height, kind }) =>
    ({ x, y, width, height, kind }));
  const actualJpegCoverage = await evaluate(privateWorker.worker, `(async()=>{
    const input=globalThis.__captainSanitizedAudit;
    if(typeof input!=='string'||!input.startsWith('data:image/jpeg;base64,'))throw Error('Sanitized JPEG unavailable');
    const bytes=Uint8Array.from(atob(input.split(',')[1]),ch=>ch.charCodeAt(0));
    const bitmap=await createImageBitmap(new Blob([bytes],{type:'image/jpeg'}));
    try{
      const canvas=new OffscreenCanvas(bitmap.width,bitmap.height),cx=canvas.getContext('2d',{willReadFrequently:true});
      cx.drawImage(bitmap,0,0);
      const pixels=cx.getImageData(0,0,bitmap.width,bitmap.height).data;
      const boxes=${JSON.stringify(pixelBoxes)};
      const sx=bitmap.width/${result.context.viewport.width},sy=bitmap.height/${result.context.viewport.height};
      const label=new Uint8Array(bitmap.width*bitmap.height);
      const regions=boxes.map(b=>{
        const x0=Math.max(0,Math.ceil(b.x*sx)+4),x1=Math.min(bitmap.width,Math.floor((b.x+b.width)*sx)-4);
        const y0=Math.max(0,Math.ceil(b.y*sy)+4),y1=Math.min(bitmap.height,Math.floor((b.y+b.height)*sy)-4);
        if(x1<=x0||y1<=y0)throw Error('Synthetic labelled region has no testable interior');
        let total=0,masked=0;
        for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++){
          const index=y*bitmap.width+x,p=index*4;label[index]=1;total++;
          if(pixels[p]<=32&&pixels[p+1]<=32&&pixels[p+2]<=32&&pixels[p+3]===255)masked++;
        }
        return {kind:b.kind,total,masked,maskedPercent:Math.round(10000*masked/total)/100};
      });
      let privateOpaque=0,privateUnmasked=0,outsideOpaque=0,outsideOther=0;
      for(let i=0;i<label.length;i++){
        const p=i*4,black=pixels[p]<=32&&pixels[p+1]<=32&&pixels[p+2]<=32&&pixels[p+3]===255;
        if(label[i]){if(black)privateOpaque++;else privateUnmasked++;}
        else{if(black)outsideOpaque++;else outsideOther++;}
      }
      return {method:'decoded-outgoing-JPEG-labelled-interior',regions,
        expectedRegions:regions.length,allLabelledInteriorsOpaque:regions.every(r=>r.masked===r.total),
        fixtureLabelledPixelConfusion:{method:'outgoing-JPEG-near-black-vs-seven-labelled-interiors',
          privateOpaque,privateUnmasked,outsideOpaque,outsideOther,
          labelledPrivateRecallPercent:Math.round(10000*privateOpaque/Math.max(1,privateOpaque+privateUnmasked))/100,
          observedOpaquePrecisionPercent:Math.round(10000*privateOpaque/Math.max(1,privateOpaque+outsideOpaque))/100,
          observedOutsideOpaquePercent:Math.round(10000*outsideOpaque/Math.max(1,outsideOpaque+outsideOther))/100,
          caveat:'Outside labels can include extra privacy masks or naturally dark pixels; this is NOT whole-web redaction precision.'}};
    }finally{bitmap.close()}
  })()`, 30000);
  assert.equal(actualJpegCoverage.allLabelledInteriorsOpaque, true,
    'One or more independently labelled private region interiors remained visible in outgoing JPEG.');
  assert.ok(result.publicPixelPreservation.sampledPixels > 0,
    'Independent public-pixel comparison had no samples.');
  // Excessive masking is a utility failure, not a privacy leak. Retain the
  // measured result instead of weakening the local row-mask/proof gate or
  // disguising an unusable preview as a successful selective-redaction result.
  result.publicPixelPreservation.selectivePreservationAccepted =
    result.publicPixelPreservation.changedPercent < 5;
  await evaluate(privateWorker.worker, `delete globalThis.__captainSanitizedAudit`);
  assert.equal(sanitizedScreenshot.length, result.sanitizedLength, 'Sanitized image transfer was truncated');
  const { backend: _localBackend, ...outboundVisualProof } = result.visual.visualPrivacy;
  // The manual fixture must follow the same device-only lease projection as
  // the production service worker; document/observation identities never go
  // to the companion, even when the fixture is synthetic.
  const { redactionBoxes: _localBoxes, ...auditContext } = result.context;
  const pageMetadata = Object.fromEntries([
    'domFingerprint', 'visibleTextHash', 'elementCount', 'meaningfulContent',
    'capturedAt', 'sanitizedScreenshotFingerprint',
  ].filter(key => Object.hasOwn(result.context.pageMetadata || {}, key))
    .map(key => [key, result.context.pageMetadata[key]]));
  // Viewport scroll/visual offsets bind the local screenshot lease, but they
  // are not companion-schema fields. Mirror the production planner projection
  // so this audit exercises the same egress boundary as a real task.
  const viewport = {
    width: result.context.viewport?.width,
    height: result.context.viewport?.height,
    devicePixelRatio: result.context.viewport?.devicePixelRatio,
  };
  const outbound = { ...auditContext, viewport, pageMetadata, screenshot: sanitizedScreenshot, visualPrivacy: outboundVisualProof };
  assert.deepEqual(payloadLeaks({ task: 'scroll down', context: outbound, history: [] }), [], 'Sanitized outbound context still matched a server PII pattern');
  const started = performance.now();
  const accepted = await fetch('http://127.0.0.1:4317/api/agent/step', { method: 'POST',
    headers: { 'content-type': 'application/json', origin: extensionOrigin,
      'x-captain-auth': companionToken },
    body: JSON.stringify({ task: 'scroll down', context: outbound, history: [] }) });
  const acceptedBody = await accepted.json();
  report.serverRoundTripMs = Math.round(performance.now() - started);
  assert.equal(accepted.status, 200, JSON.stringify(acceptedBody));
  assert.equal(acceptedBody.action.type, 'scroll');
  const fake = Buffer.alloc(120, 1); fake[0] = 0xff; fake[1] = 0xd8; fake[2] = 0xff; fake[118] = 0xff; fake[119] = 0xd9;
  const refused = await fetch('http://127.0.0.1:4317/api/agent/step', { method: 'POST',
    headers: { 'content-type': 'application/json', origin: extensionOrigin,
      'x-captain-auth': companionToken },
    body: JSON.stringify({ task: 'scroll down', context: { ...outbound, screenshot: `data:image/jpeg;base64,${fake.toString('base64')}` }, history: [] }) });
  assert.equal(refused.status, 422, 'Tampered visual payload was not rejected');
  let productionEndToEndMs = null;
  let finalState = { status: 'not-run', vision: { status: 'not-run' } };
  if (!privacyOnly) {
    // Use a bounded deterministic command. An unrecognised “inspect” task may
    // invoke an optional local planner for up to its model timeout, which tests
    // model availability rather than the browser privacy loop.
    const productionTask = 'scroll down';
    const productionRequestId = `text-audit-${Date.now().toString(36)}`;
    const productionStarted = performance.now();
    let ownTask = false, completed = false;
    try {
      const dispatched = await evaluate(session.controller,
        `chrome.runtime.sendMessage(${JSON.stringify({ type: 'START_TASK', task: productionTask,
          requestId: productionRequestId, tabId: result.tabId })})`);
      assert.equal(dispatched?.ok, true, dispatched?.error || 'The production extension loop did not accept the task');
      ownTask = true;
      finalState = null;
      let productionConsentCount = 0;
      const taskDeadline = Date.now() + 60_000;
      do {
        await new Promise(resolve => setTimeout(resolve, 250));
        finalState = await evaluate(session.controller, `chrome.runtime.sendMessage({type:'GET_STATE'})`);
        if (finalState?.status === 'waiting_privacy_consent') {
          assert.ok(++productionConsentCount <= 4, 'Synthetic production flow requested repeated privacy consent.');
          const approved = await evaluate(session.controller, `chrome.runtime.sendMessage({type:'PRIVACY_CONTINUE'})`);
          assert.equal(approved?.ok, true, approved?.error || 'Synthetic privacy consent was not accepted');
        }
        if (['complete', 'error'].includes(finalState?.status)) break;
      } while (Date.now() < taskDeadline);
      assert.equal(finalState?.status, 'complete', finalState?.message || 'The production extension loop did not complete');
      assert.equal(finalState?.vision?.status, 'sanitized', 'Production visual observation did not complete sanitization');
      completed = true;
      productionEndToEndMs = Math.round(performance.now() - productionStarted);
    } finally {
      // An audit timeout or assertion must never leave its synthetic task
      // running in the user’s normal browser. Only cancel our exact request.
      if (ownTask && !completed) {
        const current = await evaluate(session.controller, `chrome.runtime.sendMessage({type:'GET_STATE'})`).catch(() => null);
        if (current?.requestId === productionRequestId &&
            ['running', 'waiting_privacy_consent', 'waiting_human'].includes(current.status)) {
          await evaluate(session.controller, `chrome.runtime.sendMessage({type:'CANCEL_TASK'})`).catch(() => null);
        }
      }
    }
  }
  let metrics;
  for (let attempt = 0; attempt < 20; attempt++) {
    metrics = await fetch('http://127.0.0.1:4317/api/metrics').then(response => response.json());
    if (metrics.lastVisualAudit?.schema === 'captain.visual-privacy.v2') break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(metrics.lastVisualAudit?.schema, 'captain.visual-privacy.v2');
  assert.equal(metrics.lastVisualAudit?.modelSha256, result.visual.visualPrivacy.modelSha256);
  assert.equal(metrics.lastVisualAudit?.rawScreenshotReceived, false);
  const processEnd = (await cdp(version.webSocketDebuggerUrl, 'SystemInfo.getProcessInfo')).processInfo;
  const activeCpu = cpuPercent(processStart, processEnd, performance.now() - benchmarkStarted);
  await new Promise(resolve => setTimeout(resolve, 2000));
  const idleStartTime = performance.now(), idleStart = (await cdp(version.webSocketDebuggerUrl, 'SystemInfo.getProcessInfo')).processInfo;
  await new Promise(resolve => setTimeout(resolve, 3000));
  const idleEnd = (await cdp(version.webSocketDebuggerUrl, 'SystemInfo.getProcessInfo')).processInfo;
  const idleCpu = cpuPercent(idleStart, idleEnd, performance.now() - idleStartTime);
  const resourceFiles = ['../extension/faces/ultraface-rfb-320.onnx', '../extension/vendor/ort.min.js', '../extension/vendor/ort-wasm-simd-threaded.mjs', '../extension/vendor/ort-wasm-simd-threaded.wasm'];
  const footprintBytes = (await Promise.all(resourceFiles.map(path => stat(new URL(path, import.meta.url))))).reduce((sum, item) => sum + item.size, 0);
  const encoded = sanitizedScreenshot.split(',', 2)[1];
  await mkdir(new URL('../runtime/', import.meta.url), { recursive: true });
  await writeFile(new URL('../runtime/sanitized-privacy-audit.jpg', import.meta.url), Buffer.from(encoded, 'base64'));
  report.passed = true;
  report.build = result.build; report.tabId = result.tabId; report.windowId = result.windowId; report.captureMethod = result.captureMethod;
  report.productionVisualStatus = finalState.vision.status;
  report.evaluation = {
    weightsPercent: { visualContextAccuracy: 25, piiDetectionRecallAndPrecision: 20, redactionPrecision: 20, clientResourceUtilization: 20, endToEndLatency: 15 },
    visualContext,
    piiDetection,
    redaction,
    actualJpegCoverage,
    localAuditGate:result.visual.localAuditGate,
    localOcrAudit:result.visual.localOcrAudit,
    localOcrRejectClass:result.visual.localOcrRejectClass,
    localOcrRejectScope:result.visual.localOcrRejectScope,
    localStageTimings:result.visual.localStageTimings,
    publicPixelPreservation:result.publicPixelPreservation,
    clientResources: { modelAndLoadedRuntimeFootprintBytes: footprintBytes, modelAndLoadedRuntimeFootprintMiB: Number((footprintBytes / 1048576).toFixed(2)), workerJsHeapBytes: result.visual.visualPrivacy.workerJsHeapBytes, aggregateChromeWorkingSetMiBUpperBound: chromeWorkingSetMiB(idleEnd), activeAggregateCpu: activeCpu, idleAggregateCpuThreeSecondSampleAfterCooldown: idleCpu, note: 'CPU and working set are aggregate upper bounds for the dedicated Chrome instance, not extension-only attribution.' },
    latency: { localInferenceMs: result.visual.visualPrivacy.inferenceMs, localSanitizationTotalMs: result.visual.visualPrivacy.totalMs, sanitizedServerRoundTripMs: report.serverRoundTripMs, productionObservePlanExecuteMs: productionEndToEndMs }
  };
  report.localVision = result.visual.visualPrivacy;
  report.piiCounts = result.context.piiCounts;
  report.visionSummary = result.context.vision;
  report.rawScreenshotPersisted = false;
  report.sanitizedArtifact = 'runtime/sanitized-privacy-audit.jpg';
  report.assertions = {
    localModelRan: true, faceDetectionsMeasured: result.visual.visualPrivacy.faces,
    rasterFaceRegionOpaqueMasked: true, domPiiDetected: true,
    sensitiveAndUninspectableRegionsBlackedOut: true, sanitizedPayloadAccepted: true,
    tamperedPayloadRejected: true, rawScreenshotSentToServer: false,
    productionObservePlanExecuteLoopCompleted: !privacyOnly
  };
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  report.passed = false; report.error = error.stack || error.message; console.error(report.error); process.exitCode = 1;
} finally {
  report.finished = new Date().toISOString();
  await mkdir(new URL('../runtime/', import.meta.url), { recursive: true });
  await writeFile(new URL('../runtime/visual-privacy-audit.json', import.meta.url), JSON.stringify(report, null, 2));
}
