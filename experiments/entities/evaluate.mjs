// Isolated, local-only research harness. NOT loaded by CAPTAIN/extension.
// Run only on hardcoded synthetic fixtures. No network, telemetry or private inputs.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { AutoTokenizer, env } from '@huggingface/transformers';
import * as ort from 'onnxruntime-node';

env.allowRemoteModels = false;
env.allowLocalModels = true;
env.useBrowserCache = false;
process.env.HF_HUB_OFFLINE = '1';
process.env.TRANSFORMERS_OFFLINE = '1';

const root = fileURLToPath(new URL('./assets/', import.meta.url));
const modelFile = join(root, 'model.quant.onnx');
const expected = Object.freeze({
  'config.json': '6757df1ae2ec9ca16cef63009af337a66573d06c721d03c7820590f69eefa6c8',
  'tokenizer.json': 'd241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66',
  'tokenizer_config.json': '01a629a4923673b9a7a6d7da214952152c87c7ab3e002aae8e1e025486942163',
  'special_tokens_map.json': '5d5b662e421ea9fac075174bb0688ee0d9431699900b90662acd44b2a350503a',
  'vocab.txt': '07eced375cec144d27c900241f3e339478dec958f92fddbc551f295c992038a3',
  'model.quant.onnx': 'b227845ff4989c9f7383874b841895dfbdb9a4d7a20ceb39c3f187271894bf2a',
});

for (const [file, digest] of Object.entries(expected)) {
  const actual = createHash('sha256').update(await readFile(join(root, file))).digest('hex');
  if (actual !== digest) throw Error('Candidate asset integrity failed.');
}
const config = JSON.parse(await readFile(join(root, 'config.json'), 'utf8'));
const mapping = config.id2label;
const count = Object.keys(mapping).length;
if (config.model_type !== 'bert' || config.architectures?.[0] !== 'BertForTokenClassification' ||
    count !== 51 || Object.keys(config.label2id ?? {}).length !== 51 ||
    Array.from({ length: count }, (_, i) => i).some(i => config.label2id[mapping[i]] !== i) ||
    mapping[0] !== 'O') throw Error('Candidate label schema mismatch.');

const tokenizer = await AutoTokenizer.from_pretrained(root, { local_files_only: true });
const session = await ort.InferenceSession.create(modelFile, { executionProviders: ['cpu'], intraOpNumThreads: 2 });
const fixtures = [
  { id: 'email', text: 'Contact Jane Doe at jane.doe@example.com.', expected: ['EMAIL_ADDRESS'] },
  { id: 'phone', text: 'My phone number is 555-123-4567.', expected: ['PHONE_NUMBER'] },
  { id: 'username', text: 'Hello from user marie@example.com.', expected: ['EMAIL_ADDRESS'] },
  { id: 'ordinary', text: 'A notebook is on the wooden desk.', expected: [] },
  { id: 'email-alone', text: 'jane.doe@example.com', expected: ['EMAIL_ADDRESS'] },
  { id: 'email-short', text: 'Email: jane.doe@example.com', expected: ['EMAIL_ADDRESS'] },
  { id: 'name-short', text: 'Jane Doe', expected: ['PERSON'] },
  { id: 'phone-short', text: 'Phone: 555-123-4567', expected: ['PHONE_NUMBER'] },
  { id: 'public-short', text: 'Hello world.', expected: [] },
];

function extractLabel(output, tokenCount) {
  if (!output?.dims || output.dims.length !== 3 || output.dims[0] !== 1 ||
      output.dims[1] !== tokenCount || output.dims[2] !== count ||
      output.data.length !== tokenCount * count) throw Error('Model output does not match label schema.');
  const predictions = [];
  for (let i = 0; i < tokenCount; i++) {
    const row = output.data.subarray(i * count, (i + 1) * count);
    if (row.some(value => !Number.isFinite(value))) throw Error('Nonfinite model logit.');
    let bestIndex = 0;
    for (let j = 1; j < count; j++) if (row[j] > row[bestIndex]) bestIndex = j;
    const maximum = row[bestIndex];
    let sum = 0;
    for (let j = 0; j < count; j++) sum += Math.exp(row[j] - maximum);
    const score = 1 / sum;
    predictions.push({ label: mapping[bestIndex], score });
  }
  return predictions;
}

const results = [];
for (const fixture of fixtures) {
  const started = performance.now();
  const tokens = await tokenizer(fixture.text, {
    add_special_tokens: true, truncation: false, return_offsets_mapping: true,
  });
  const n = tokens.input_ids?.dims?.[1];
  if (!Number.isSafeInteger(n) || n < 3 || n > 512) throw Error('Token count invalid.');
  const feeds = {};
  for (const name of session.inputNames) {
    const value = tokens[name];
    if (!value?.data || value.data.length !== n) throw Error('Missing tokenizer tensor: ' + name);
    feeds[name] = new ort.Tensor('int64', BigInt64Array.from(value.data, BigInt), [1, n]);
  }
  const outputs = await session.run(feeds);
  const predictions = extractLabel(outputs[session.outputNames[0]], n);
  const entityTypes = [...new Set(predictions
    .filter(p => p.label !== 'O' && p.score >= 0.5)
    .map(p => p.label.replace(/^[BI]-/, '')))];
  results.push({ id: fixture.id, tokenCount: n, entityTypes, expectedTypes: fixture.expected,
    minConfidence: Math.min(...predictions.slice(1, -1).map(p => p.score)),
    inferenceMs: Math.round(performance.now() - started) });
}
console.log(JSON.stringify({
  candidate: 'gravitee-io/bert-small-pii-detection', revision: 'f8c27a85c51c0168f07b9dcf00265bf0a4097939',
  isolation: true, remoteModels: false, modelSha256: expected['model.quant.onnx'],
  architecture: config.architectures[0], labels: count, inputNames: session.inputNames, outputNames: session.outputNames,
  results,
}, null, 2));
