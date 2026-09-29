/* Independently written, bounded ASCII subset of the pinned BERT tokenizer.
 * It is deliberately NOT a general-purpose Unicode tokenizer: unsupported
 * OCR text must trigger full screenshot blackout, not guessed token offsets.
 * No raw token, word or dictionary value crosses the local worker boundary.
 */
(() => {
  'use strict';
  const FAIL = () => { throw new Error('Local alternative tokenization unavailable.'); };
  const punctuation = character => {
    const code = character.charCodeAt(0);
    return (code >= 33 && code <= 47) || (code >= 58 && code <= 64) ||
      (code >= 91 && code <= 96) || (code >= 123 && code <= 126);
  };
  function create(vocabulary) {
    if (typeof vocabulary !== 'string' || vocabulary.length < 200_000 || vocabulary.length > 300_000) FAIL();
    const lines = vocabulary.split(/\r?\n/);
    if (lines.at(-1) === '') lines.pop();
    if (lines.length !== 30522 || lines.some((line, index) => !line || line.includes('\r') || line.length > 100)) FAIL();
    const tokens = new Map(lines.map((token, index) => [token, index]));
    if (tokens.size !== lines.length || tokens.get('[UNK]') !== 100 ||
        tokens.get('[CLS]') !== 101 || tokens.get('[SEP]') !== 102) FAIL();

    function pieces(word) {
      if (typeof word !== 'string' || !word.trim() || word.length > 128 ||
          !/^[\x20-\x7e]+$/.test(word)) FAIL();
      // BertNormalizer(lowercase=true, strip_accents=null) + BertPreTokenizer
      // on this *strict ASCII* input subset only. Every punctuation character
      // is its own pretoken, with no dropped characters.
      const normalized = word.toLowerCase();
      const chunks = [];
      let chunk = '';
      for (const char of normalized) {
        if (char === ' ' || punctuation(char)) {
          if (chunk) chunks.push(chunk);
          chunk = '';
          if (char !== ' ') chunks.push(char);
        } else chunk += char;
      }
      if (chunk) chunks.push(chunk);
      if (!chunks.length) FAIL();
      const out = [];
      for (const part of chunks) {
        if (part.length > 100) FAIL();
        const startAt = out.length;
        for (let start = 0; start < part.length;) {
          let found = null;
          for (let end = part.length; end > start; end--) {
            const key = (start ? '##' : '') + part.slice(start, end);
            const id = tokens.get(key);
            if (id !== undefined) { found = { id, end }; break; }
          }
          if (!found || found.id === 100) FAIL(); // Do not mask unknown text as ordinary.
          out.push(found.id);
          start = found.end;
        }
        if (out.length === startAt) FAIL();
      }
      return out;
    }

    function encodeWords(words) {
      if (!Array.isArray(words) || words.length < 1 || words.length > 600) FAIL();
      const ids = [101], tokenToWord = [-1];
      for (let index = 0; index < words.length; index++) {
        const parts = pieces(words[index]?.text);
        for (const part of parts) {
          ids.push(part);
          tokenToWord.push(index);
          if (ids.length >= 512) FAIL(); // No silent 512-token truncation.
        }
      }
      ids.push(102);
      tokenToWord.push(-1);
      return { ids, tokenToWord };
    }
    return Object.freeze({ encodeWords });
  }
  globalThis.CaptainAlternativeWordPiece = Object.freeze({ create });
})();
