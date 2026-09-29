/* Phase-07 Option B. Independently licensed gravitee-io BERT-small PII NER.
 * Exact original publisher's quantized ONNX, NOT TrueSight or the mismatched
 * third-party ONNX conversion. Source pixels/text never leave this worker.
 * Only extra opaque rectangles or full blackout may be returned.
 */
(() => {
  'use strict';
  const BASE = new URL('entities/', self.location.href);
  const ERROR = 'Local alternative PII unavailable.';
  const FULL = () => ({ fullBlackout: true, regions: [] });
  const MODEL_SHA256 = 'b227845ff4989c9f7383874b841895dfbdb9a4d7a20ceb39c3f187271894bf2a';
  const ASSETS = Object.freeze({
    'model.quant.onnx': [28_732_710, MODEL_SHA256],
    'config.json': [3044, '6757df1ae2ec9ca16cef63009af337a66573d06c721d03c7820590f69eefa6c8'],
    'vocab.txt': [231508, '07eced375cec144d27c900241f3e339478dec958f92fddbc551f295c992038a3']
  });
  let initialized;
  const fail = () => { throw new Error(ERROR); };
  function localURL(name) {
    const url = new URL(name, BASE);
    if (!['chrome-extension:', 'moz-extension:'].includes(url.protocol) ||
        url.protocol !== BASE.protocol || url.host !== BASE.host ||
        url.pathname !== BASE.pathname + name || url.search || url.hash) fail();
    return url.href;
  }
  async function digest(bytes) {
    const value = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(value), byte => byte.toString(16).padStart(2, '0')).join('');
  }
  async function asset(name) {
    const response = await fetch(localURL(name), { cache: 'no-store', credentials: 'omit' });
    if (!response?.ok) fail();
    const bytes = await response.arrayBuffer();
    const [length, hash] = ASSETS[name];
    if (bytes.byteLength !== length || await digest(bytes) !== hash) fail();
    return bytes;
  }
  function labels(config) {
    if (config?.model_type !== 'bert' || config.architectures?.[0] !== 'BertForTokenClassification' ||
        config.vocab_size !== 30522 || typeof config.id2label !== 'object' ||
        typeof config.label2id !== 'object' ||
        Object.keys(config.id2label).length !== 51 || Object.keys(config.label2id).length !== 51 ||
        config.id2label[0] !== 'O' || config.label2id.O !== 0) fail();
    const mapped = [];
    for (let id = 0; id < 51; id++) {
      const label = config.id2label[id];
      if (typeof label !== 'string' || config.label2id[label] !== id ||
          (id !== 0 && !/^[BI]-[A-Z0-9_]+$/.test(label))) fail();
      mapped.push(label);
    }
    return mapped;
  }
  function initialize() {
    initialized ||= (async () => {
      if (typeof globalThis.CaptainAlternativeWordPiece?.create !== 'function' ||
          typeof ort?.InferenceSession?.create !== 'function' || typeof ort.Tensor !== 'function') fail();
      const [modelBytes, configBytes, vocabBytes] = await Promise.all([
        asset('model.quant.onnx'), asset('config.json'), asset('vocab.txt')
      ]);
      const decoder = new TextDecoder('utf-8', { fatal: true });
      const mapped = labels(JSON.parse(decoder.decode(configBytes)));
      const tokenizer = globalThis.CaptainAlternativeWordPiece.create(decoder.decode(vocabBytes));
      const model = await ort.InferenceSession.create(new Uint8Array(modelBytes), {
        executionProviders: ['wasm'], graphOptimizationLevel: 'all'
      });
      if (model.inputNames?.length !== 2 || !model.inputNames.includes('input_ids') ||
          !model.inputNames.includes('attention_mask') ||
          model.outputNames?.length !== 1 || model.outputNames[0] !== 'logits') fail();
      return { mapped, tokenizer, model };
    })();
    return initialized;
  }
  function validateWords(words, width, height) {
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) ||
        width <= 0 || height <= 0 || width * height > 12_000_000 ||
        !Array.isArray(words) || !words.length || words.length > 600) fail();
    for (const word of words) {
      const box = word?.bbox;
      if (typeof word?.text !== 'string' || !word.text.trim() || word.text.length > 128 ||
          !/^[\x20-\x7e]+$/.test(word.text) ||
          typeof word.confidence !== 'number' || !Number.isFinite(word.confidence) ||
          word.confidence < 80 || word.confidence > 100 ||
          !box || ![box.x0, box.y0, box.x1, box.y1].every(Number.isFinite) ||
          box.x0 < 0 || box.y0 < 0 || box.x1 > width || box.y1 > height ||
          box.x1 <= box.x0 || box.y1 <= box.y0) fail();
    }
  }
  function reviewOutput(result, tokenToWord, mapped, words) {
    const count = mapped.length, length = tokenToWord.length;
    const logits = result?.logits;
    if (logits?.type !== 'float32' || logits.dims?.length !== 3 ||
        logits.dims[0] !== 1 || logits.dims[1] !== length ||
        logits.dims[2] !== count || logits.data?.length !== length * count) fail();
    const selected = new Set();
    for (let index = 1; index < length - 1; index++) {
      const word = tokenToWord[index];
      if (!Number.isSafeInteger(word) || word < 0 || word >= words.length) fail();
      const base = index * count;
      let best = 0, max = -Infinity;
      for (let label = 0; label < count; label++) {
        const value = logits.data[base + label];
        if (!Number.isFinite(value)) fail();
        if (value > max) { max = value; best = label; }
      }
      let total = 0;
      for (let label = 0; label < count; label++) total += Math.exp(logits.data[base + label] - max);
      const score = 1 / total;
      if (!Number.isFinite(score) || score <= 0 || score > 1) fail();
      // A structurally verified but ambiguous token does not justify hiding
      // every public pixel. Its source word is itself made opaque; a high-
      // confidence non-O label is masked the same way. Structural, asset,
      // alignment and runtime failures still return FULL() above.
      if (score < 0.90 || mapped[best] !== 'O') selected.add(word);
    }
    const regions = [...selected].map(index => {
      const box = words[index].bbox;
      return { x1: box.x0, y1: box.y0, x2: box.x1, y2: box.y1, kind: 'PII' };
    });
    return { fullBlackout: false, regions };
  }
  async function detect(words, width, height) {
    try {
      validateWords(words, width, height);
      const { mapped, tokenizer, model } = await initialize();
      const { ids, tokenToWord } = tokenizer.encodeWords(words);
      if (ids.length < 3 || ids.length > 512 || tokenToWord.length !== ids.length) fail();
      const dims = [1, ids.length];
      const feeds = {
        input_ids: new ort.Tensor('int64', BigInt64Array.from(ids, BigInt), dims),
        attention_mask: new ort.Tensor('int64', BigInt64Array.from(ids, () => 1n), dims)
      };
      let timer;
      const result = await Promise.race([
        model.run(feeds),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(ERROR)), 5000); })
      ]).finally(() => clearTimeout(timer));
      return reviewOutput(result, tokenToWord, mapped, words);
    } catch { return FULL(); } // Never return or log raw OCR, model output, or exceptions.
  }
  globalThis.CaptainAlternativePII = Object.freeze({
    ready: true, modelSha256: MODEL_SHA256, detect
  });
})();
