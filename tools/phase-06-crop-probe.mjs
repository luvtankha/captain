// Research-only on the existing immutable ONNX checkpoint. Never packaged.
// Exercises the SAME strict adapter on different synthetic screenshot crops.
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { adapter, decodePng, EXPECTED_SHA, lease } from './phase-06-real-inference.mjs';
import ort from 'onnxruntime-web';

const input = decodePng(await readFile(new URL('../benchmarks/phase-06-isolated-ui.png', import.meta.url)));
const truth = JSON.parse((await readFile(new URL('../benchmarks/phase-06-ground-truth.json', import.meta.url), 'utf8')).replace(/^\uFEFF/, ''));
const crops = [
  [0, 0, 1024, 768], [0, 0, 512, 768], [512, 0, 512, 768],
  [0, 0, 1024, 384], [0, 384, 1024, 384],
  [0, 0, 512, 384], [512, 0, 512, 384],
  [0, 384, 512, 384], [512, 384, 512, 384],
  [200, 400, 500, 250], [200, 200, 600, 400]
];
function crop([left, top, width, height]) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    const start = ((top + y) * input.width + left) * 4;
    pixels.set(input.pixels.subarray(start, start + width * 4), y * width * 4);
  }
  return { width, height, pixels };
}
function iou(a, b) {
  const x = Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1));
  const y = Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1));
  const area = x * y;
  return area / ((a.x2-a.x1)*(a.y2-a.y1)+(b.x2-b.x1)*(b.y2-b.y1)-area);
}
ort.env.wasm.numThreads = 1;
const client = adapter();
const results = [];
for (const rect of crops) {
  const start = performance.now();
  try {
    const image = crop(rect);
    const record = await client.detector.detect(image, image.width, image.height, lease);
    const detections = record.detections.map(d => {
      const b=d.box, box={x1:b.x1+rect[0],y1:b.y1+rect[1],x2:b.x2+rect[0],y2:b.y2+rect[1]};
      return {score:d.confidence, box, bestIOU:Math.max(...truth.map(t=>iou(box,t.box)))};
    });
    results.push({rect, elapsedMs:Math.round(performance.now()-start), count:detections.length, detections});
  } catch {
    results.push({rect, elapsedMs:Math.round(performance.now()-start), error:'Local UI detector unavailable.'});
  }
}
const report = {modelSha256:EXPECTED_SHA,scope:'research-only Node VM canvas approximation, not browser-native validation',runs:client.runs(),results};
await writeFile(new URL('../benchmarks/phase-06-crop-probe.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
