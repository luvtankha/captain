import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { sanitizeMetricSample } from '../server/metrics.mjs';

const source=await readFile(new URL('../extension/service-worker.js',import.meta.url),'utf8');
const sandbox={ URL,AbortController,performance,setTimeout,clearTimeout,
  chrome:{runtime:{id:'synthetic-extension',onMessage:{addListener(){}}}} };
vm.createContext(sandbox);
vm.runInContext(source,sandbox);

test('real extension metrics project only the receiving endpoint allowlist',()=>{
  const raw={ mode:'DOM+UltraFace+local-redaction',status:'sanitized',faces:1,
    redactionBoxes:8,inferenceMs:8.7,totalMs:17,
    interactiveRegions:100,imageCount:3,mediaCount:0,
    searchQuery:'CANARY_private',screenshot:'data:image/jpeg;base64,PRIVATE',
    rawScreenshotTransmitted:false };
  const payload=sandbox.metricProjection(100,6,2,raw);
  const checked=sanitizeMetricSample(JSON.parse(JSON.stringify(payload)));
  assert.deepEqual(JSON.parse(JSON.stringify(checked)),{
    latencyMs:100,piiDetected:6,steps:2,vision:{mode:'DOM+UltraFace+local-redaction',
      status:'sanitized',rawScreenshotTransmitted:false,faces:1,
      redactionBoxes:8,inferenceMs:9,totalMs:17}
  });
  assert.doesNotMatch(JSON.stringify(payload),/CANARY|PRIVATE|data:image|"screenshot":|searchQuery|imageCount|interactiveRegions/i);
});

test('unknown telemetry strings and malformed numbers cannot enter outbound metrics',()=>{
  const payload=sandbox.metricProjection(90,0,1,{mode:'CANARY_private',status:'CANARY_private',
    faces:NaN,redactionBoxes:Infinity,inferenceMs:-4,totalMs:4_000_000,personal:'CANARY_private'});
  assert.deepEqual(JSON.parse(JSON.stringify(sanitizeMetricSample(payload))),{
    latencyMs:90,piiDetected:0,steps:1,vision:{mode:'unknown',status:'unknown',rawScreenshotTransmitted:false}
  });
  assert.doesNotMatch(JSON.stringify(payload),/CANARY|personal|Infinity|NaN/);
});
