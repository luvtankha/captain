// Research-only ONNX metadata from a never-packaged isolated candidate.
// No screenshot, OCR, personal data or model outputs leave this local process.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import ort from 'onnxruntime-web';
const path = new URL('../experiments/detectors/omniparser-community-int8.onnx', import.meta.url);
const bytes = await readFile(path);
const sha256 = createHash('sha256').update(bytes).digest('hex');
if (sha256 !== 'ee3cb8e8f527b1f2a18e9553d03dc8a08de21bd8b5423a505dc014c8d107f2d0' ||
    bytes.length !== 3226312) throw Error('Research-only ONNX identity mismatch.');
ort.env.wasm.numThreads=1;ort.env.wasm.simd=true;
const started=performance.now();
const session=await ort.InferenceSession.create(new Uint8Array(bytes),{
  executionProviders:['wasm'],graphOptimizationLevel:'all'
});
const slim=meta=>Object.fromEntries(Object.entries(meta).map(([name,m])=>[name,
  {type:m.type,dimensions:m.shape??m.dimensions??m.dims??null}]));
console.log(JSON.stringify({sha256,bytes:bytes.length,loadMs:Math.round(performance.now()-started),
  inputNames:session.inputNames,outputNames:session.outputNames,
  inputs:slim(session.inputMetadata),outputs:slim(session.outputMetadata)}));
await session.release?.();
