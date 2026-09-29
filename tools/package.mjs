import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { zipDirectory } from './archive.mjs';
const root = fileURLToPath(new URL('..', import.meta.url));
const dist = join(root, 'build');
execFileSync(process.execPath, [join(root, 'tools', 'sync-action-binding.mjs')]);
// The shared classic privacy engine is a mandatory runtime asset in both builds.
const privacyCore = join(root, 'extension', 'privacy', 'privacy-core.js');
if (!(await readFile(privacyCore, 'utf8')).includes('CAPTAIN_PRIVACY')) throw new Error('Privacy core is missing or incomplete.');
// Phase-04 packaging requires the pinned, licensed local face detector and its
// WASM runtime. A missing/corrupt asset must fail before producing either ZIP.
const visionAssets = [
  ['faces/ultraface-rfb-320.onnx', 1_163_666],
  ['faces/ULTRAFACE-LICENSE.txt', 1],
  ['vendor/ort.min.js', 1],
  ['vendor/ort-wasm-simd-threaded.mjs', 1],
  ['vendor/ort-wasm-simd-threaded.wasm', 1],
  ['vendor/ONNXRUNTIME-LICENSE.txt', 1],
  ['vision-core.js', 1],
  ['vision-worker.js', 1],
];
for (const [name, minimumBytes] of visionAssets) {
  const bytes = await readFile(join(root, 'extension', name));
  if (bytes.length < minimumBytes) throw new Error(`Required packaged vision asset is unavailable: ${name}`);
  if (name === 'faces/ultraface-rfb-320.onnx' &&
      createHash('sha256').update(bytes).digest('hex') !== 'd7c687949526065ab6a192fdf993360045ce27b0fabf7c9fca5c2437b786b495') {
    throw new Error('Bundled UltraFace model identity mismatch.');
  }
}
// Phase-05 OCR is optional at capture time, but an enabled package must never
// silently fall back to a CDN, cached model, or mismatched local runtime.
const ocrAssets = [
  ['vendor/tesseract.min.js', 62961, '10fff78484067759c43028a02a72d76d0b90eb17302bb23b58a9ec5410bc928b'],
  ['vendor/worker.min.js', 111162, '38645599043239c0eb6db08a6504a92dcdc292200535f3e9339cd77c4443b842'],
  ['vendor/tesseract-core-lstm.wasm.js', 3954181, '775a35df6f2ae100e02609443e6bd5cafcd07983dd6175454ca4a432a7730687'],
  ['vendor/tesseract-core-lstm.wasm', 2871085, '220e2e87551edccb85519796a170469f8ab2a8055216789e3b8b1ada18b7bc2b'],
  ['vendor/tesseract-core-simd-lstm.wasm.js', 3954569, '9d7c43fb206dc9f48475228b46bf35f888fa9e6259da2e67d5a75c77049f2dc7'],
  ['vendor/tesseract-core-simd-lstm.wasm', 2871377, '187d76742dfc0d8929f0b49a619f145bb6370730776c7bd0d3e20c6b2098808d'],
  ['languages/eng.traineddata.gz', 2952873, '45b4cb346724ac1774f1c36f42f182b887bcdb28ebe63e6fff90ac41f3fcff91']
];
for (const [name, bytesExpected, hash] of ocrAssets) {
  const bytes = await readFile(join(root, 'extension', 'text', name));
  if (bytes.length !== bytesExpected || createHash('sha256').update(bytes).digest('hex') !== hash) {
    throw new Error(`Bundled local OCR asset integrity failed: ${name}`);
  }
}
for (const name of [
  'ocr-runtime.js', 'worker-bootstrap.js', 'NOTICE.txt', 'LANGUAGE-DATA-MIT-LICENSE.txt',
  'vendor/TESSERACTJS-LICENSE.txt', 'vendor/TESSERACTCORE-LICENSE.txt',
  'vendor/tesseract.min.js.LICENSE.txt', 'vendor/worker.min.js.LICENSE.txt'
]) {
  if ((await readFile(join(root, 'extension', 'text', name))).length < 50) {
    throw new Error(`Required local OCR runtime or license is unavailable: ${name}`);
  }
}
const ocrSource = await readFile(join(root, 'extension', 'text', 'ocr-runtime.js'), 'utf8');
if (!ocrSource.includes("workerBlobURL: false") || !ocrSource.includes("cacheMethod: 'none'") ||
    !ocrSource.includes("Local OCR unavailable.") || !ocrSource.includes("langPath: localURL('languages/')") ||
    !ocrSource.includes("corePath: localURL('vendor/')")) {
  throw new Error('Local OCR runtime requires reviewed offline and fail-closed settings.');
}
// Phase-06 pinned FP32 ONNX detector. The upstream model card says MIT, but
// its disclosed YOLOv5 pretrained lineage carries AGPL obligations. Ship the
// complete upstream AGPL text and the unmodified revision-pinned model card;
// do not represent this model as MIT-only or allow other checkpoint bytes.
const uiDir = join(root, 'extension', 'controls');
// The selected TrueSight archive contains source but NO matching classifier
// weights/tokenizer. Keep its optional bridge disabled until an independently
// verified offline checkpoint is implemented and tested; never package a
// claim of operational TrueSight inference from a config-only reference.
const trueSightDir = join(root, 'extension', 'reference');
const trueSightBridge = await readFile(join(trueSightDir, 'privacy-bridge.js'), 'utf8');
const trueSightNotice = await readFile(join(trueSightDir, 'NOTICE.txt'), 'utf8');
const workerSource = await readFile(join(root, 'extension', 'vision-worker.js'), 'utf8');
if (!trueSightBridge.includes('ready:false') || !trueSightBridge.includes('fullBlackout: true') ||
    !trueSightNotice.includes('no TrueSight classifier accuracy') ||
    !workerSource.includes("'reference/privacy-bridge.js'") ||
    (await readdir(trueSightDir)).some(name => /\.(?:onnx|pt|pth|safetensors|bin|gguf)$/i.test(name))) {
  throw new Error('Unverified TrueSight activation or missing privacy bridge notice.');
}
// Option B is a separately identified Apache-2.0 ONNX model, NEVER silently
// substituted for the missing TrueSight weights. Package only these exact
// original-publisher model/tokenizer bytes and independent fail-closed code.
const altDir = join(root, 'extension', 'entities');
const altFiles = [
  ['model.quant.onnx', 28_732_710, 'b227845ff4989c9f7383874b841895dfbdb9a4d7a20ceb39c3f187271894bf2a'],
  ['config.json', 3044, '6757df1ae2ec9ca16cef63009af337a66573d06c721d03c7820590f69eefa6c8'],
  ['vocab.txt', 231508, '07eced375cec144d27c900241f3e339478dec958f92fddbc551f295c992038a3'],
  ['ATTRIBUTION.txt', 13451, '2b047773ebf24c021432eea343ffc15e35603aa2895d3ccdf95b8d448fef43e6']
];
for (const [name, expectedLength, expectedHash] of altFiles) {
  const bytes = await readFile(join(altDir, name));
  if (bytes.length !== expectedLength || createHash('sha256').update(bytes).digest('hex') !== expectedHash) {
    throw new Error('Local independent PII asset integrity failed: ' + name);
  }
}
const altNotice = await readFile(join(altDir, 'NOTICE.txt'), 'utf8');
const altLicense = await readFile(join(altDir, 'APACHE-2.0-LICENSE.txt'), 'utf8');
const altRuntime = await readFile(join(altDir, 'pii-runtime.js'), 'utf8');
const altWordPiece = await readFile(join(altDir, 'wordpiece.js'), 'utf8');
if (!altNotice.includes('not TrueSight') || !altNotice.includes('Apache-2.0') ||
    !altLicense.includes('Apache License') || !altLicense.includes('Version 2.0') ||
    !altRuntime.includes('ready: true') || !altRuntime.includes('fullBlackout: true') ||
    !altRuntime.includes(altFiles[0][2]) || !altWordPiece.includes('CaptainAlternativeWordPiece') ||
    !workerSource.includes("'entities/wordpiece.js', 'entities/pii-runtime.js'") ||
    (await readdir(altDir)).some(name => /\.(?:onnx|pt|pth|safetensors|bin|gguf)$/i.test(name) && name !== 'model.quant.onnx')) {
  throw new Error('Independent PII privacy, identity or licensing guard failed.');
}
for (const name of ['ui-model.js', 'ui-fusion.js', 'NOTICE.txt', 'ATTRIBUTION.txt', 'YOLOV5-AGPL-3.0-LICENSE.txt']) {
  if ((await readFile(join(uiDir, name))).length < 100) throw new Error('UI vision capability contract missing.');
}
const uiBridge = await readFile(join(uiDir, 'ui-model.js'), 'utf8');
const uiSha256 = 'd29b6210d171e3dc5454e09847aaabce6a0255eaefa565b639e1301a9e933ef9';
const uiModel = await readFile(join(uiDir, 'model.onnx'));
if (uiModel.length !== 7481347 || createHash('sha256').update(uiModel).digest('hex') !== uiSha256 ||
    !uiBridge.includes('ready: true') || !uiBridge.includes(uiSha256) ||
    !uiBridge.includes('Local UI detector unavailable.') ||
    !(await readFile(join(uiDir, 'NOTICE.txt'), 'utf8')).includes('AGPL-3.0') ||
    !(await readFile(join(uiDir, 'YOLOV5-AGPL-3.0-LICENSE.txt'), 'utf8')).includes('GNU AFFERO GENERAL PUBLIC LICENSE') ||
    (await readdir(uiDir)).some(name => /\.(?:onnx|pt|pth|safetensors|bin|gguf)$/i.test(name) && name !== 'model.onnx')) {
  throw new Error('Pinned local UI detector integrity, license or runtime contract failed.');
}
// Packaging owns only these two staging directories, not compiled types,
// previous release evidence or other outputs beneath dist.
await mkdir(dist, { recursive: true });
for (const name of ['chrome', 'firefox']) {
  await rm(join(dist, name), { recursive: true, force: true });
}
await cp(join(root, 'extension'), join(dist, 'chrome'), { recursive: true });
// Model-classifier experiments and raw research weights are deliberately NOT
// part of the publishable extension. Production uses only the audited pinned
// detector. This is a fixed path under the generated dist tree, never user data.
await rm(join(dist, 'chrome', 'controls', 'experiments'), { recursive: true, force: true });
// Diagnostic pages/workers are used only with a disposable unpacked profile.
// Never expose them in a packaged extension, including their OCR debug copy.
for (const name of [
  'phase-06-live.html', 'phase-06-live-worker.js', 'phase-06-live-ocr-worker.js',
  'text/phase06-debug-runtime.js', 'text/phase06-debug-bootstrap.js',
  'controls/ui-shape.js'
]) await rm(join(dist, 'chrome', name), { force: true });
const chromeManifest = JSON.parse(await readFile(join(dist, 'chrome', 'manifest.json'), 'utf8'));
if (chromeManifest.content_scripts?.[0]?.js?.join(',') !== 'privacy/privacy-core.js,content-script.js') throw new Error('Content-script privacy core must load first.');
// The Chrome/Edge offscreen vision host is a mandatory private worker context,
// not an unused diagnostic page. Ship it and the shared fail-closed worker.
for (const name of ['vision-host.js', 'offscreen.js', 'offscreen.html'])
  if ((await readFile(join(dist, 'chrome', name))).length < 50)
    throw new Error('Packaged private vision host is missing: ' + name);
// The WASM-only bundle is pinned to the smaller default runtime. Do not ship
// the unused JSEP/WebGPU binaries that were retained in the development tree.
await rm(join(dist, 'chrome', 'vendor', 'ort-wasm-simd-threaded.jsep.mjs'), { force: true });
await rm(join(dist, 'chrome', 'vendor', 'ort-wasm-simd-threaded.jsep.wasm'), { force: true });
await zipDirectory(join(dist, 'chrome'), join(dist, 'captain-chrome.zip'));
await cp(join(dist, 'chrome'), join(dist, 'firefox'), { recursive: true });
const firefoxManifestPath = join(dist, 'firefox', 'manifest.json');
const firefoxManifest = JSON.parse(await readFile(firefoxManifestPath, 'utf8'));
firefoxManifest.background = { scripts: ['privacy/privacy-core.js', 'action-binding-runtime.js', 'service-worker.js'] };
firefoxManifest.permissions = firefoxManifest.permissions.filter(permission => !['debugger', 'offscreen'].includes(permission));
// Firefox retains the existing private popup worker path; Chrome-only
// offscreen API/permission must not be claimed by its static package.
for (const name of ['offscreen.html', 'offscreen.js'])
  await rm(join(dist, 'firefox', name), { force: true });
firefoxManifest.browser_specific_settings = { gecko: { id: 'captain@local.sih', strict_min_version: '121.0' } };
await writeFile(firefoxManifestPath, `${JSON.stringify(firefoxManifest, null, 2)}\n`);
await zipDirectory(join(dist, 'firefox'), join(dist, 'captain-firefox.zip'));
console.log(`Packaged extension in ${dist}`);
