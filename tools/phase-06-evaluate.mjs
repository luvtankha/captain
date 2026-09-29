// Independent, disposable-Edge DOM labels vs actual ONNX/WASM predictions.
// This is a one-page synthetic fixture score, never a domain-wide benchmark.
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { adapter, decodePng, EXPECTED_SHA, lease, syntheticRaster } from './phase-06-real-inference.mjs';
import ort from 'onnxruntime-web';

const base = new URL('../benchmarks/', import.meta.url);
// Historical PNG is intentionally absent from a clean source distribution.
// Reproduce the zero-detection control with a generated non-personal raster.
const png = await readFile(new URL('phase-06-isolated-ui.png', base)).catch(error => {
  if (error?.code === 'ENOENT') return null;
  throw error;
});
const groundTruth = JSON.parse((await readFile(new URL('phase-06-ground-truth.json', base), 'utf8')).replace(/^\uFEFF/, ''));
const raster = png ? decodePng(png) : syntheticRaster();
const overlap = (a, b) => {
  const w = Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1));
  const h = Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1));
  const common = w * h;
  return common / ((a.x2 - a.x1) * (a.y2 - a.y1) + (b.x2 - b.x1) * (b.y2 - b.y1) - common);
};
export async function evaluate() {
  ort.env.wasm.numThreads = 1;
  const { detector, runs } = adapter();
  const actual = await detector.detect(raster, raster.width, raster.height, lease);
  const candidates = actual.detections.flatMap((prediction, pi) => groundTruth.map((truth, gi) => ({
    pi, gi, iou: overlap(prediction.box, truth.box)
  }))).filter(pair => pair.iou >= 0.5).sort((a, b) => b.iou - a.iou);
  const matchedPred = new Set(), matchedTruth = new Set(), matches = [];
  for (const candidate of candidates) {
    if (matchedPred.has(candidate.pi) || matchedTruth.has(candidate.gi)) continue;
    matchedPred.add(candidate.pi); matchedTruth.add(candidate.gi);
    matches.push({ groundTruthIndex: candidate.gi, predictionIndex: candidate.pi, iou: candidate.iou });
  }
  const tp = matches.length, fp = actual.detections.length - tp, fn = groundTruth.length - tp;
  return {
    scope: png
      ? 'ONE isolated synthetic 1024x768 Edge page, 9 browser DOM-labelled interactive controls; no population accuracy estimate'
      : 'Generated synthetic 640x640 no-image-file fallback; nine historical labels provide a deterministic zero-detection control, NOT a geometrically comparable browser score',
    modelSha256: EXPECTED_SHA, actualModelRuns: runs(), iouThreshold: 0.5, confidenceThreshold: 0.75,
    groundTruthCount: groundTruth.length, predictions: actual.detections.length,
    truePositive: tp, falsePositive: fp, falseNegative: fn,
    precision: tp + fp ? tp / (tp + fp) : null, recall: tp + fn ? tp / (tp + fn) : null,
    matches
  };
}
if (process.argv[1] && fileURLToPath(import.meta.url).toLowerCase() === process.argv[1].toLowerCase()) {
  const result = await evaluate();
  await writeFile(new URL('phase-06-fixture-evaluation.json', base), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
}
