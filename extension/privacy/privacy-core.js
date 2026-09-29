/*
 * CAPTAIN Phase-03 deterministic privacy core.
 * Classic script for MV3, Firefox and vm.runInNewContext; Node can side-effect
 * import this file. There is deliberately no export of raw values or mappings.
 * Offsets are UTF-16 JavaScript string offsets, exclusive at end.
 */
(() => {
  'use strict';

  const MAX_TEXT = 16_384;
  const MAX_CANDIDATES = 256;
  const PRIVATE = Object.freeze({
    EMAIL: 100, PHONE: 95, PAN: 95, AADHAAR: 95, CARD: 95,
    API_KEY: 115, TOKEN: 110, PASSWORD: 120, OTP: 120, PIN: 120,
    CREDENTIAL: 125, PERSON: 90, ADDRESS: 90, ACCOUNT: 85, UNKNOWN: 5
  });
  const PLACEHOLDER = /\[(?:REDACTED(?:_[A-Z_]+)?|(?:EMAIL|PHONE|PAN|AADHAAR|CARD|API_KEY|TOKEN|PASSWORD|OTP|PIN|CREDENTIAL|PERSON|ADDRESS|ACCOUNT|UNKNOWN)_\d+)\]/g;
  const TOKEN_KEYS = new Set(['apikey', 'accesstoken', 'authtoken', 'refreshtoken', 'idtoken', 'token', 'secret', 'clientsecret', 'clientkey', 'authorization', 'auth', 'authcode', 'code', 'jwt', 'session', 'sessionid', 'sessiontoken', 'sessionkey', 'privatekey', 'key', 'signature', 'sig', 'password', 'passwd', 'pwd', 'credential', 'credentials', 'otp', 'pin', 'cvv', 'cvc', 'pan', 'aadhaar', 'aadhar', 'account', 'accountnumber', 'card', 'cardnumber', 'email', 'phone', 'mobile']);
  const KIND_ALIASES = Object.freeze({
    SECRET: 'CREDENTIAL', PRIVATE: 'CREDENTIAL', CVV: 'CREDENTIAL',
    CVC: 'CREDENTIAL', SECURITY_ANSWER: 'CREDENTIAL', APIKEY: 'API_KEY',
    FULL_NAME: 'PERSON', FIRST_NAME: 'PERSON', LAST_NAME: 'PERSON',
    GIVEN_NAME: 'PERSON', FAMILY_NAME: 'PERSON', NAME: 'PERSON',
    PASSPORT: 'ACCOUNT', NATIONAL_ID: 'ACCOUNT', DOB: 'ACCOUNT',
    DATE_OF_BIRTH: 'ACCOUNT', BANK_ACCOUNT: 'ACCOUNT', IFSC: 'ACCOUNT',
    AADHAR: 'AADHAAR'
  });

  // Verhoeff permutation tables, used for the final Aadhaar check digit.
  const D = [
    [0,1,2,3,4,5,6,7,8,9], [1,2,3,4,0,6,7,8,9,5],
    [2,3,4,0,1,7,8,9,5,6], [3,4,0,1,2,8,9,5,6,7],
    [4,0,1,2,3,9,5,6,7,8], [5,9,8,7,6,0,4,3,2,1],
    [6,5,9,8,7,1,0,4,3,2], [7,6,5,9,8,2,1,0,4,3],
    [8,7,6,5,9,3,2,1,0,4], [9,8,7,6,5,4,3,2,1,0]
  ];
  const P = [
    [0,1,2,3,4,5,6,7,8,9], [1,5,7,6,2,8,3,0,9,4],
    [5,8,0,3,7,9,6,1,4,2], [8,9,1,6,0,4,3,5,2,7],
    [9,4,5,3,1,2,6,8,7,0], [4,2,8,6,5,7,3,9,0,1],
    [2,7,9,3,8,0,6,4,1,5], [7,0,4,6,9,1,3,2,5,8]
  ];
  function aadhaarValid(digits) {
    if (!/^[2-9]\d{11}$/.test(digits)) return false;
    let check = 0;
    for (let i = 0; i < digits.length; i++) check = D[check][P[i % 8][Number(digits[digits.length - 1 - i])]];
    return check === 0;
  }
  function luhnValid(digits) {
    if (!/^\d{13,19}$/.test(digits) || /^(\d)\1+$/.test(digits)) return false;
    let sum = 0, twice = false;
    for (let i = digits.length - 1; i >= 0; i--) {
      let n = Number(digits[i]);
      if (twice) { n *= 2; if (n > 9) n -= 9; }
      sum += n;
      twice = !twice;
    }
    return sum % 10 === 0;
  }
  const normalizeKind = value => {
    const name = String(value).trim().replace(/[\s-]+/g, '_').toUpperCase();
    return KIND_ALIASES[name] || (Object.hasOwn(PRIVATE, name) ? name : null);
  };
  function scanSpans(value) {
    if (typeof value !== 'string' || value.length > MAX_TEXT) {
      return [{ start: 0, end: typeof value === 'string' ? value.length : 0, type: 'UNKNOWN' }];
    }
    const candidates = [];
    const protectedRanges = [];
    for (const match of value.matchAll(PLACEHOLDER)) protectedRanges.push([match.index, match.index + match[0].length]);
    let overflow = false;
    function add(start, end, type) {
      if (!(start >= 0 && end > start && end <= value.length) || protectedRanges.some(([a, b]) => start < b && end > a)) return;
      if (candidates.length >= MAX_CANDIDATES) { overflow = true; return; }
      candidates.push({ start, end, type });
    }
    function each(regex, type, group = 0) {
      regex.lastIndex = 0;
      let match;
      while ((match = regex.exec(value)) !== null) {
        if (overflow) break;
        const part = match[group];
        if (!part) continue;
        const start = match.index + (group ? match[0].lastIndexOf(part) : 0);
        add(start, start + part.length, type);
      }
    }
    each(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, 'EMAIL');
    each(/\b[A-Z0-9._%+-]+%40[A-Z0-9.-]+(?:\.|%2E)[A-Z]{2,}\b/gi, 'EMAIL');
    each(/(?<![A-Za-z0-9_])(?:\+?91[ .-]?)?[6-9](?:[ .-]?\d){9}(?![A-Za-z0-9_])/g, 'PHONE');
    each(/(?<![A-Za-z0-9_])[A-Z]{5}\d{4}[A-Z](?![A-Za-z0-9_])/gi, 'PAN');
    each(/\bCANARY(?:[_\s:-][^\r\n|;,{}<>]{0,16384})?/gi, 'CREDENTIAL');
    each(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]{0,16384}?(?:-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|$)/gi, 'CREDENTIAL');
    // Long invalid numbers are private ACCOUNT candidates: failed checksums do
    // not imply permission to transmit an otherwise account-shaped value.
    const numerics = /(?<![A-Za-z0-9_])\d(?:[ ./-]?\d){11,18}(?![A-Za-z0-9_])/g;
    for (const match of value.matchAll(numerics)) {
      const digits = match[0].replace(/[ ./-]/g, '');
      const type = digits.length === 12 && aadhaarValid(digits) ? 'AADHAAR' :
        luhnValid(digits) ? 'CARD' : 'ACCOUNT';
      add(match.index, match.index + match[0].length, type);
    }
    // URL query and fragment keys carry credential values even when percent
    // encoded. Keep delimiters intact, but mask the complete value atomically.
    const query = /[?&#]([A-Za-z%][\w.%-]{0,80})=([^&#\s"'<>]{1,16384})/g;
    for (const match of value.matchAll(query)) {
      let key;
      try { key = decodeURIComponent(match[1]).replace(/[_.-]/g, '').toLowerCase(); }
      catch { key = ''; }
      if (!TOKEN_KEYS.has(key)) continue;
      const type = /password|passwd|pwd/.test(key) ? 'PASSWORD' :
        /otp/.test(key) ? 'OTP' : /^pin$/.test(key) ? 'PIN' :
        /email/.test(key) ? 'EMAIL' : /phone|mobile/.test(key) ? 'PHONE' :
        /account|pan|aadhaar|aadhar|card/.test(key) ? 'ACCOUNT' :
        /apikey/.test(key) ? 'API_KEY' : 'TOKEN';
      const part = match[2];
      const start = match.index + match[0].length - part.length;
      add(start, start + part.length, type);
    }
    const encodedQuery = /(?:%3[fF]|%26|%23)([A-Za-z%][A-Za-z0-9_.%-]{0,80})%3[dD]((?:(?!%26|%23|[&#\s"'<>]).){1,16384})/g;
    for (const match of value.matchAll(encodedQuery)) {
      let key;
      try { key = decodeURIComponent(match[1]).replace(/[_.-]/g, '').toLowerCase(); }
      catch { key = ''; }
      if (!TOKEN_KEYS.has(key)) continue;
      const part = match[2];
      add(match.index + match[0].length - part.length, match.index + match[0].length,
        /password|passwd|pwd/.test(key) ? 'PASSWORD' : 'TOKEN');
    }
    each(/\bhttps?%3A%2F%2F[^\s<>"']{4,512}/gi, 'UNKNOWN');
    each(/https?:\/\/([^\s/@]+)@/gi, 'CREDENTIAL', 1);
    each(/\bBearer\s+([^\s,;'"<>]{3,16384})/gi, 'TOKEN', 1);
    each(/\b(?:sk-(?:proj-|test-|live-)?[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{12,}|AKIA[0-9A-Z]{16})\b/g, 'API_KEY');
    each(/\b(?:eyJ[A-Za-z0-9_-]{12,}\.)[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{8,}\b/g, 'TOKEN');
    each(/\/(?:reset|activate|verify|auth|invite|token|key)\/([A-Za-z0-9_%.~-]{12,})/gi, 'TOKEN', 1);
    const labeled = /(?<![?&#])\b(password|passwd|passcode|pwd|otp|one[ -]?time[ -]?(?:password|code)|pin|cvv|cvc|security[ -]?answer|api[ _-]?key|access[ _-]?token|auth[ _-]?token|refresh[ _-]?token|token|secret|credential|account(?:[ _-]?(?:number|no))?|bank[ _-]?account|card(?:[ _-]?(?:number|no))?|e-?mail|phone|mobile|passport(?:[ _-]?number)?|national[ _-]?id|ifsc)\s*(?:(?:number|value|code)\s*)?(?::|=|\bis\b)\s*(?:"([^"\r\n]{1,16384})"|'([^'\r\n]{1,16384})'|([^\r\n|;,{}<>]{1,16384}))/gi;
    for (const match of value.matchAll(labeled)) {
      const key = match[1].replace(/[\s_-]+/g, '').toLowerCase();
      const type = /password|passwd|passcode|pwd/.test(key) ? 'PASSWORD' :
        /otp|onetime/.test(key) ? 'OTP' : key === 'pin' ? 'PIN' :
        /api.?key/.test(key) ? 'API_KEY' :
        /email/.test(key) ? 'EMAIL' :
        /phone|mobile/.test(key) ? 'PHONE' :
        /token|secret|credential/.test(key) ? 'TOKEN' : 'ACCOUNT';
      const part = (match[2] || match[3] || match[4] || '').trimEnd();
      if (!part) continue;
      const start = match.index + match[0].lastIndexOf(part);
      add(start, start + part.length, type);
    }
    // Labels for names and addresses are semantic PII even if no digit pattern
    // is present; cap each capture and stop at field delimiters or next label.
    const person = /\b(full[ _-]?name|first[ _-]?name|last[ _-]?name|given[ _-]?name|family[ _-]?name|name|shipping[ _-]?address|billing[ _-]?address|street[ _-]?address|address)\s*[:=]\s*([^\r\n|;,]{2,80})/gi;
    for (const match of value.matchAll(person)) {
      const type = /address/i.test(match[1]) ? 'ADDRESS' : 'PERSON';
      let part = match[2];
      const nextLabel = /\s+(?:(?:e-?mail|phone|name|address|password|account|card|otp|pan)\s*[:=])/i.exec(part);
      if (nextLabel) part = part.slice(0, nextLabel.index);
      part = part.trimEnd();
      const start = match.index + match[0].indexOf(match[2]);
      add(start, start + part.length, type);
    }
    // Ambiguous opaque identifiers receive an UNKNOWN span. The caller can
    // block the whole string or explicitly choose to redact the span.
    const opaque = /(?<![A-Za-z0-9_])[A-Za-z0-9_-]{28,}(?![A-Za-z0-9_])/g;
    for (const match of value.matchAll(opaque)) {
      if (/[A-Za-z]/.test(match[0]) && (match[0].match(/\d/g) || []).length >= 4) {
        add(match.index, match.index + match[0].length, 'UNKNOWN');
      }
    }
    if (overflow) return [{ start: 0, end: value.length, type: 'UNKNOWN' }];
    candidates.sort((a, b) => a.start - b.start || b.end - a.end || PRIVATE[b.type] - PRIVATE[a.type]);
    const merged = [];
    for (const span of candidates) {
      const previous = merged[merged.length - 1];
      if (!previous || span.start >= previous.end) {
        merged.push({ ...span });
      } else {
        previous.end = Math.max(previous.end, span.end);
        if (PRIVATE[span.type] > PRIVATE[previous.type]) previous.type = span.type;
      }
    }
    return merged;
  }

  function createSession() {
    // Raw-to-placeholder entries live exclusively inside this closure and are
    // neither returned nor put on the global API, audit, history or errors.
    const mapping = new Map();
    const counters = new Map();
    function sanitizeText(value, options = {}) {
      if (typeof value !== 'string' || value.length > MAX_TEXT ||
          !options || typeof options !== 'object') {
        return { text: '[REDACTED_UNKNOWN]', found: ['UNKNOWN'], blocked: true };
      }
      try {
      const policy = options.unknownPolicy === undefined ? 'block' : options.unknownPolicy;
      if (policy !== 'block' && policy !== 'redact') {
        return { text: '[REDACTED_UNKNOWN]', found: ['UNKNOWN'], blocked: true };
      }
      const explicit = options.kind === undefined || options.kind === '' ? null : normalizeKind(options.kind);
      if (options.kind !== undefined && options.kind !== '' && !explicit) {
        return { text: '[REDACTED_UNKNOWN]', found: ['UNKNOWN'], blocked: true };
      }
      const spans = explicit && value && !/^\[(?:REDACTED(?:_[A-Z_]+)?|[A-Z_]+_\d+)\]$/.test(value)
        ? [{ start: 0, end: value.length, type: explicit }] : scanSpans(value);
      const found = [...new Set(spans.map(span => span.type))];
      if (spans.some(span => span.type === 'UNKNOWN') && policy === 'block') {
        return { text: '[REDACTED_UNKNOWN]', found, blocked: true };
      }
      const replacements = spans.map(span => {
        const raw = value.slice(span.start, span.end);
        // Length-prefixed key avoids ambiguity between adjacent type and raw
        // components without ever serializing this key outside the closure.
        const key = span.type + ':' + raw.length + ':' + raw;
        let token = mapping.get(key);
        if (!token) {
          const next = (counters.get(span.type) || 0) + 1;
          counters.set(span.type, next);
          token = `[${span.type}_${next}]`;
          mapping.set(key, token);
        }
        return { ...span, token };
      });
      let text = value;
      for (let i = replacements.length - 1; i >= 0; i--) {
        const span = replacements[i];
        text = text.slice(0, span.start) + span.token + text.slice(span.end);
      }
      return { text, found, blocked: false };
      } catch {
        // Never throw untrusted text, getter payloads or internal mapping keys.
        return { text: '[REDACTED_UNKNOWN]', found: ['UNKNOWN'], blocked: true };
      }
    }
    function clear() { mapping.clear(); counters.clear(); }
    return Object.freeze({ sanitizeText, clear });
  }
  globalThis.CAPTAIN_PRIVACY = Object.freeze({ scanSpans, createSession });
})();
