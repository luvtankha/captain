/* Phase-07: source-compatible, fail-closed optional local NER adapter.
 * No verified TrueSight checkpoint/tokenizer is bundled. Never claim ready.
 * Raw text and predictions are local to the visual worker; only masks return.
 */
(() => {
  'use strict';
  const FULL = () => ({ fullBlackout: true, regions: [] });
  const finite = n => typeof n === 'number' && Number.isFinite(n);
  const labels = new Set(['PERSON', 'ADDRESS', 'EMAIL', 'PHONE', 'ACCOUNT', 'CARD', 'PAN', 'AADHAAR', 'PASSWORD', 'TOKEN', 'CREDENTIAL']);
  function review({ words, width, height, predictions, complete, modelVerified } = {}) {
    try {
      if (modelVerified !== true || complete !== true || !Number.isSafeInteger(width) ||
          !Number.isSafeInteger(height) || width < 1 || height < 1 || width * height > 12_000_000 ||
          !Array.isArray(words) || !words.length || words.length > 600 ||
          !Array.isArray(predictions) || predictions.length > 600) return FULL();
      const boxes = words.map(w => {
        const b = w?.bbox;
        if (typeof w?.text !== 'string' || !w.text.trim() || w.text.length > 128 ||
            !/^[\x20-\x7e]+$/.test(w.text) || !finite(w.confidence) || w.confidence < 80 ||
            !b || ![b.x0,b.y0,b.x1,b.y1].every(finite) || b.x0 < 0 || b.y0 < 0 ||
            b.x1 > width || b.y1 > height || b.x1 <= b.x0 || b.y1 <= b.y0) throw Error();
        return b;
      });
      // Model must explicitly resolve every token, including O-labelled text;
      // uncertainty is not evidence that a word can be exposed.
      if (predictions.length !== boxes.length) return FULL();
      const regions = [];
      for (let i = 0; i < predictions.length; i++) {
        const p = predictions[i];
        if (!p || p.wordIndex !== i || typeof p.label !== 'string' ||
            !finite(p.score) || p.score < 0.9 || p.score > 1 ||
            (p.label !== 'O' && !labels.has(p.label))) return FULL();
        if (p.label !== 'O') {
          const b = boxes[i];
          regions.push({ x1:b.x0, y1:b.y0, x2:b.x1, y2:b.y1, kind:'PII' });
        }
      }
      return { fullBlackout:false, regions };
    } catch { return FULL(); }
  }
  // Source archive supplies no matching weights/tokenizer. Explicitly disabled.
  globalThis.CaptainTrueSight = Object.freeze({ ready:false, review });
})();
