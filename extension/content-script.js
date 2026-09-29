(() => {
  const now = () => globalThis.performance?.now?.() ?? Date.now();
  if (globalThis.__captainPageController?.isAlive()) return;
  globalThis.__captainPageController?.dispose();
  // A reloaded extension gets a new isolated context, but the old DOM remains.
  // Tell a previous panel to stop its timers/listeners before replacing it.
  if (chrome.runtime.id) {
    document.dispatchEvent?.(new Event('captain:panel-replaced'));
    document.querySelector('#captain-agent-host')?.remove();
  }
  let connected = true, disposePanel = () => {}, setPrivacyPreview = () => false, setPrivacyNotice = () => false, previewUnavailable = () => {};
  let capturePanelState = null;
  const realExtension = !!chrome.runtime?.id;
  // The manifest loads this classic core first in the isolated extension world.
  // Only legacy source-only VM fixtures lacking runtime.id use the old fallback.
  const privacyCore = globalThis.CAPTAIN_PRIVACY;
  let privacySession = null;
  try {
    if (typeof privacyCore?.scanSpans === 'function' && typeof privacyCore?.createSession === 'function') {
      privacySession = privacyCore.createSession();
    }
  } catch {}
  const privacyReady = typeof privacySession?.sanitizeText === 'function' && typeof privacySession?.clear === 'function';
  let privacyBlocked = false;
  const PRIVATE_OBSERVATION_ERROR = 'Privacy check failed; observation blocked.';
  function requirePrivacy() {
    if (realExtension && !privacyReady) throw new Error('Local privacy engine unavailable; observation blocked.');
    if (realExtension && privacyBlocked) throw new Error(PRIVATE_OBSERVATION_ERROR);
  }
  function clearPrivateSession() {
    privacySession?.clear();
    privacyBlocked = false;
    lastObservationId = '';
    observedTargets.clear(); observedSnapshots.clear(); discoveredLinks.clear();
    domRevision++; geometryRevision++;
    scopeCache = controlCache = null;
  }
  function pageHidden() { clearPrivateSession(); }
  const opaqueToken = () => {
    const bytes = new Uint8Array(16);
    if (globalThis.crypto?.getRandomValues) {
      globalThis.crypto.getRandomValues(bytes);
      return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
    }
    // The legacy VM fixtures have no browser crypto; an actual extension
    // must fail closed instead of minting predictable document identities.
    return realExtension ? '' : `fixture-${Date.now()}-${Math.random()}`;
  };
  const documentToken = opaqueToken();
  function runtimeAlive() { try { return connected && !!chrome.runtime.id; } catch { return false; } }
  function dispose() {
    connected = false;
    clearPrivateSession();
    disposePanel();
    mutationObserver?.disconnect();
    if (mutationTimer) clearTimeout(mutationTimer);
    globalThis.removeEventListener?.('scroll', topLevelGeometryChanged, true);
    globalThis.removeEventListener?.('resize', windowGeometryChanged);
    globalThis.visualViewport?.removeEventListener?.('resize', viewportResizeChanged);
    globalThis.visualViewport?.removeEventListener?.('scroll', viewportScrollChanged);
    try { chrome.runtime.onMessage.removeListener?.(onMessage); } catch {}
    document.removeEventListener?.('captain:panel-replaced', dispose);
    globalThis.removeEventListener?.('pagehide', pageHidden);
  }
  let observationStage = 'idle', privacyFailureStage = '';
  globalThis.__captainPageController = { isAlive: runtimeAlive, dispose,
    // Isolated-world local diagnostics: fixed stage names, never page data.
    scanStatus: () => ({ stage: observationStage, privacyBlocked, privacyFailureStage }) };
  document.addEventListener?.('captain:panel-replaced', dispose, { once: true });
  globalThis.addEventListener?.('pagehide', pageHidden);
  const REDACTORS = [
    ['EMAIL', /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi],
    ['PHONE', /(?<!\d)(?:\+?91[-\s]?)?[6-9]\d{9}(?!\d)/g],
    ['CARD', /\b(?:\d[ -]*?){13,19}\b/g],
    ['AADHAAR', /\b\d{4}[ -]?\d{4}[ -]?\d{4}\b/g],
    ['PAN', /\b[A-Z]{5}\d{4}[A-Z]\b/g],
  ];
  const SECRET_HINT = /password|passcode|otp|one.?time|cvv|cc-|card.?number|aadhaar|pan.?number|account.?number/i;
  function sensitiveInputType(el) {
    if (!el) return '';
    const hint = `${el.type || ''} ${el.name || ''} ${el.id || ''} ${el.autocomplete || ''} ${el.getAttribute?.('aria-label') || ''} ${el.getAttribute?.('placeholder') || ''} ${el.labels?.[0]?.innerText || ''}`.toLowerCase();
    if (el.hasAttribute?.('data-private') || el.hasAttribute?.('data-sensitive') || el.getAttribute?.('aria-secret') === 'true') return 'secret';
    if (el.type === 'password' || /password|passcode/.test(hint)) return 'password';
    // A text input with only an associated Email label is still an email
    // field. Preserve its typed [EMAIL_n] placeholder rather than folding it
    // into the generic credential kind; the field remains locally protected.
    if (el.type === 'email' || /\be-?mail\b/.test(hint)) return 'email';
    if (/one.?time|\botp\b/.test(hint)) return 'otp';
    if (/\bcvv\b|security.?code/.test(hint)) return 'cvv';
    if (/card.?number|cc-number/.test(hint)) return 'card';
    if (/\bpin\b/.test(hint)) return 'pin';
    if (/api.?key/.test(hint)) return 'api-key';
    if (/bearer|access.?token|auth.?token|session.?id/.test(hint)) return 'token';
    if (/security.?answer/.test(hint)) return 'security-answer';
    if (/\b(?:shipping[_ -]?address|billing[_ -]?address|street[_ -]?address|address[_ -]?line\d?|postal[_ -]?code|zip[_ -]?code|full[_ -]?name|first[_ -]?name|last[_ -]?name|given[_ -]?name|family[_ -]?name|date[_ -]?of[_ -]?birth|birth[_ -]?date|birthday|bday|passport|national[_ -]?id|telephone|phone[_ -]?number|mobile[_ -]?number|bank[_ -]?account|iban|account[_ -]?number)\b/.test(hint)) return 'secret';
    if (/secret|private.?credential|account.?number|a[ad]+ha+r|\bpan\b|\bdob\b|\baddress\b|\bname\b|user[_ -]?name|\blogin\b/.test(hint) &&
        /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName || '')) return 'secret';
    return '';
  }

  function fixtureRedact(value) {
    let text = String(value || '');
    const found = [];
    for (const [kind, regex] of REDACTORS) {
      regex.lastIndex = 0;
      text = text.replace(regex, () => { found.push(kind); return `[REDACTED_${kind}]`; });
    }
    text = text.replace(/\b(name|full name|address|date of birth|dob|passport(?: number)?|account(?: number)?|ifsc)\s*:\s*([^\n|·]{3,80})/gi, (_all, label) => {
      found.push(label.toUpperCase().replaceAll(' ', '_'));
      return `${label}: [REDACTED_PII]`;
    });
    return { text, found };
  }

  function fixtureTextFindings(value) {
    const text = String(value || ''), findings = [];
    for (const [kind, regex] of REDACTORS) {
      regex.lastIndex = 0;
      for (const match of text.matchAll(regex)) findings.push({ kind, index: match.index, length: match[0].length });
    }
    const semantic = /\b(name|full name|address|date of birth|dob|passport(?: number)?|account(?: number)?|ifsc)\s*:\s*([^\n|·]{3,80})/gi;
    for (const match of text.matchAll(semantic)) findings.push({ kind: 'PII', index: match.index, length: match[0].length });
    return findings;
  }
  function redact(value, options = {}) {
    if (privacyReady) {
      let result;
      try { result = privacySession.sanitizeText(String(value ?? ''), options); } catch {}
      if (!result || typeof result.text !== 'string' || !Array.isArray(result.found) ||
          typeof result.blocked !== 'boolean' || result.blocked) {
        if (realExtension) {
          // Optional-DOM catches may swallow exceptions. The sticky marker
          // independently prevents any OBSERVE result from being returned.
          privacyBlocked = true;
          privacyFailureStage ||= observationStage + (String(value ?? '').length > 16384 ? ':oversized' : result?.found?.includes('UNKNOWN') ? ':unknown' : ':engine');
          lastObservationId = '';
          throw new Error(PRIVATE_OBSERVATION_ERROR);
        }
        return { text: '[REDACTED_UNKNOWN]', found: ['UNKNOWN'], blocked: true };
      }
      return result;
    }
    if (realExtension) throw new Error(PRIVATE_OBSERVATION_ERROR);
    return fixtureRedact(value);
  }
  function textFindings(value) {
    if (privacyReady) return privacyCore.scanSpans(String(value ?? '')).map(span => ({ kind: span.type, index: span.start, length: span.end - span.start }));
    if (realExtension) return [{ kind: 'UNKNOWN', index: 0, length: String(value ?? '').length }];
    return fixtureTextFindings(value);
  }

  function safeNavigationHref(value) {
    try {
      const url = new URL(value);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return '';
      const path = `${url.origin}${url.pathname}`, decoded = decodeURIComponent(url.pathname);
      // Links are optional context. Omit a private/unknown URL entirely before
      // invoking the session sanitizer: a token-bearing link is not a reason
      // to poison an otherwise safe observation. Queries/fragments never leave.
      // Keep this projection aligned with the companion's URL contract. An
      // encoded delimiter or traversal segment can conceal a query, fragment,
      // credential-like token, or a different logical destination after
      // decoding. It is safer to omit one optional link than reject a whole
      // otherwise privacy-safe live-page observation.
      if (/%(?:25|3f|23|40)/i.test(url.pathname) || /(?:^|\/)\.\.(?:\/|$)/.test(url.pathname) ||
        textFindings(path).length || textFindings(decoded).length) return '';
      return redact(path).text;
    } catch { return ''; }
  }

  function sensitiveTextRegions(scopes = [{ root: document, framePath: 'top' }], strict = false, detectedOnly = false) {
    if (typeof NodeFilter === 'undefined') {
      if (strict) throw new Error(PRIVATE_OBSERVATION_ERROR);
      return [];
    }
    const regions = [];
    let visited = 0, inspected = 0;
    for (const scope of scopes) {
      const base = scope.root.body || scope.root;
      if (!base) continue;
      const owner = base.ownerDocument || scope.root;
      const walker = owner.createTreeWalker?.(base, NodeFilter.SHOW_TEXT);
      const LocalRange = owner.defaultView?.Range || globalThis.Range;
      if (!walker || typeof LocalRange !== 'function') {
        if (strict) throw new Error(PRIVATE_OBSERVATION_ERROR);
        continue;
      }
      let node;
      while ((node = walker.nextNode())) {
        // Traversal and expensive visible-content scanning have independent
        // budgets. Whitespace/off-screen nodes must not exhaust the latter.
        if (++visited > 20000) { if (strict) throw new Error(PRIVATE_OBSERVATION_ERROR); break; }
        const parent = node.parentElement, value = node.nodeValue || '';
        if (!parent || !value.trim() || /^(?:script|style|noscript|template)$/i.test(parent.tagName) || !visible(parent)) continue;
        if (++inspected > 1600 || regions.length >= 160) { if (strict) throw new Error(PRIVATE_OBSERVATION_ERROR); break; }
        for (const finding of textFindings(value)) {
          if (detectedOnly && finding.kind === 'UNKNOWN') continue;
          const range = new LocalRange();
          try {
            // A semantically identified address commonly occupies an entire
            // paragraph/list entry. Its Range covers glyphs, but line-box
            // background/anti-aliased pixels can extend across the containing
            // block. Mask the whole bounded small semantic block, never only
            // the narrow Range. This ADDS coverage; no unmasking or text egress.
            if (strict && finding.kind === 'ADDRESS' && /^(?:P|LI|DD|ADDRESS)$/i.test(parent.tagName)) {
              const box = topRect(parent);
              if (![box.x, box.y, box.width, box.height].every(Number.isFinite) ||
                  box.width <= 0 || box.height <= 0 ||
                  box.width * box.height > innerWidth * innerHeight * 0.25)
                throw new Error(PRIVATE_OBSERVATION_ERROR);
              regions.push({ x: box.x, y: box.y, width: box.width, height: box.height, kind: finding.kind });
              continue;
            }
            range.setStart(node, finding.index); range.setEnd(node, finding.index + finding.length);
            let masked = false;
            for (const rect of range.getClientRects()) if (rect.width > 1 && rect.height > 1) {
              // For nested frames, a conservative parent-sized mask ensures
              // all frame pixels are withheld if coordinates are ambiguous.
              const box = scope.framePath.includes('/frame') ? topRect(parent) : rect;
              if (![box.x, box.y, box.width, box.height].every(Number.isFinite) || box.width <= 0 || box.height <= 0)
                throw new Error(PRIVATE_OBSERVATION_ERROR);
              regions.push({ x: box.x, y: box.y, width: box.width, height: box.height, kind: finding.kind });
              masked = true;
            }
            if (strict && !masked) {
              if (detectedOnly) throw new Error(PRIVATE_OBSERVATION_ERROR);
              // A visible private text node with no usable Range rectangles
              // cannot simply be omitted from the screenshot mask list.
              const box = topRect(parent);
              if (![box.x, box.y, box.width, box.height].every(Number.isFinite) || box.width <= 0 || box.height <= 0)
                throw new Error(PRIVATE_OBSERVATION_ERROR);
              regions.push({ x: box.x, y: box.y, width: box.width, height: box.height, kind: finding.kind });
            }
          } catch (error) { if (strict) throw new Error(PRIVATE_OBSERVATION_ERROR); }
          if (regions.length >= 160) break;
        }
      }
      if (visited > 20000 || inspected > 1600 || regions.length >= 160) {
        if (strict) throw new Error(PRIVATE_OBSERVATION_ERROR);
        break;
      }
    }
    return regions;
  }

  // This local preview describes detected fields, not authorization to share
  // pixels. Uninspected images/backgrounds must never become field markers.
  function localFieldSnapshot() {
    if (!runtimeAlive() || !privacyReady) throw new Error('Local field scan unavailable.');
    flushMutations();
    const scopes = controlScopes();
    const boxes = sensitiveTextRegions(scopes, true, true).filter(box =>
      !['UNKNOWN', 'RASTER_CONTENT', 'BACKGROUND_IMAGE'].includes(box.kind));
    for (const { root } of scopes) {
      const fields = [...(root.querySelectorAll?.('input,textarea,select,[contenteditable="true"],[role="textbox"]') || [])];
      if (fields.length > 1500) throw new Error('Local field budget exceeded.');
      for (const el of fields) {
        if (isCaptainNode(el) || el.type === 'hidden' || !visible(el)) continue;
        const labels = safeLabel(el);
        const hint = [el.type, el.name, el.id, el.autocomplete, el.placeholder, labels.text]
          .filter(Boolean).join(' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]/g, ' ').toLowerCase();
        let kind = '';
        if (el.type === 'password' || /password|passcode/.test(hint)) kind = 'PASSWORD';
        else if (/a[ad]+ha+r/.test(hint)) kind = 'AADHAAR';
        else if (/\bpan\b|permanent account number/.test(hint)) kind = 'PAN';
        else if (/birth|\bdob\b|\bbday\b/.test(hint)) kind = 'DATE_OF_BIRTH';
        else if (/\be ?mail\b/.test(hint)) kind = 'EMAIL';
        else if (/\baddress\b|\bstreet\b|postal|\bzip\b/.test(hint)) kind = 'ADDRESS';
        else if (/user ?name|\blogin\b|sign ?in/.test(hint)) kind = 'CREDENTIAL';
        else if (/\bname\b/.test(hint)) kind = 'PERSON';
        else if (/phone|mobile|telephone|\btel\b/.test(hint)) kind = 'PHONE';
        else if (/\botp\b|one time/.test(hint)) kind = 'OTP';
        else if (/\bcvv\b|security code/.test(hint)) kind = 'CVV';
        else if (/\bpin\b/.test(hint)) kind = 'PIN';
        else if (/card number|cc number/.test(hint)) kind = 'CARD';
        else if (sensitiveInputType(el)) kind = 'SECRET';
        else if (typeof el.value === 'string') kind = textFindings(el.value).find(item => item.kind !== 'UNKNOWN')?.kind || '';
        if (kind) boxes.push({ ...topRect(el), kind });
        if (boxes.length > 500) throw new Error('Local field budget exceeded.');
      }
    }
    const unique = [...new Map(boxes.map(box => [JSON.stringify(box), box])).values()];
    return { documentToken, domRevision, geometryRevision,
      viewport: { width: innerWidth, height: innerHeight, devicePixelRatio,
        scrollX: Number(globalThis.scrollX) || 0, scrollY: Number(globalThis.scrollY) || 0 },
      boxes: unique };
  }

  function uninspectableVisualRegions(scopes = [{ root: document }], strict = false) {
    const regions = [], seen = new Set();
    const add = (el, kind) => {
      if (!el || seen.has(el) || !visible(el)) return;
      if (regions.length >= 120) {
        if (strict) throw new Error(PRIVATE_OBSERVATION_ERROR);
        return;
      }
      const rect = topRect(el);
      if (rect.width < 3 || rect.height < 3) return;
      seen.add(el); regions.push({ x: rect.x, y: rect.y, width: rect.width, height: rect.height, kind });
    };
    for (const { root } of scopes) {
      root.querySelectorAll?.('img,picture,canvas,video,iframe,frame,embed,object,svg,[role="img"],input[type="image"]').forEach(el => add(el, 'RASTER_CONTENT'));
    }
    // CSS background images can contain text/identifiers that DOM scanning cannot inspect.
    for (const { root } of scopes) {
      const styled = [...(root.querySelectorAll?.('body *,*') || [])];
      // Bound total traversal separately from viewport style inspection.
      // Off-screen nodes cannot contribute pixels to the captured viewport.
      if (strict && styled.length > 20000) throw new Error(PRIVATE_OBSERVATION_ERROR);
      let inspected = 0;
      for (const el of styled.slice(0, 20000)) {
        if (!visible(el)) continue;
        if (++inspected > 2500) { if (strict) throw new Error(PRIVATE_OBSERVATION_ERROR); break; }
        if (regions.length >= 120) {
          if (strict) throw new Error(PRIVATE_OBSERVATION_ERROR);
          break;
        }
        try {
          const win = el.ownerDocument?.defaultView || globalThis;
          const style = win.getComputedStyle?.(el) || getComputedStyle(el);
          if (style?.backgroundImage && style.backgroundImage !== 'none') add(el, 'BACKGROUND_IMAGE');
          if (strict) for (const pseudo of ['::before', '::after']) {
            const content = win.getComputedStyle?.(el, pseudo)?.content;
            if (content && content !== 'none' && content !== 'normal' && content !== '""' && content !== "''") add(el, 'BACKGROUND_IMAGE');
          }
        } catch (error) { if (strict) throw new Error(PRIVATE_OBSERVATION_ERROR); }
      }
      if (regions.length >= 120) break;
    }
    return regions;
  }

  function visible(el) {
    if (!el?.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    const win = el.ownerDocument?.defaultView || globalThis;
    const s = win.getComputedStyle?.(el) || getComputedStyle(el);
    if (!(r.width > 2 && r.height > 2 && s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0' &&
      r.bottom >= 0 && r.right >= 0 && r.top <= (win.innerHeight || innerHeight) && r.left <= (win.innerWidth || innerWidth))) return false;
    if (el.closest?.('[aria-hidden="true"],[inert]')) return false;
    const frame = win.frameElement;
    return !frame || visible(frame);
  }

  function detectHumanChallenge() {
    const title = String(document.title || '');
    const text = String(document.body?.innerText || '').slice(0, 12000);
    const selectors = [
      'iframe[src*="recaptcha"]', 'iframe[src*="hcaptcha"]', '[class*="h-captcha"]',
      '[id*="captcha" i]', '[class*="captcha" i]', 'input[name*="captcha" i]',
      'form[action*="captcha" i]', '[data-sitekey]', '[aria-label*="human verification" i]'
    ];
    const selectorHit = selectors.find(selector => {
      try {
        return [...document.querySelectorAll(selector)].some(element => {
          // Many ordinary pages load invisible anti-bot widgets or a small
          // provider badge. Their presence is not a request for human input.
          // A visible challenge still stops all automated actions.
          if (element.closest?.('.grecaptcha-badge') || element.getAttribute?.('data-size') === 'invisible') return false;
          const source = element.getAttribute?.('src') || '';
          if (/[?&]size=invisible(?:&|$)/i.test(source)) return false;
          return visible(element);
        });
      } catch { return false; }
    });
    const phrases = [
      /verify (?:that )?you(?:'re| are) (?:a )?human/i,
      /complete the (?:security )?check/i,
      /enter the characters you see/i,
      /automated access|unusual traffic|bot verification/i,
      /captcha/i
    ];
    const phrase = phrases.find(pattern => pattern.test(`${title}\n${text}`));
    // A casual article mentioning CAPTCHA is not a challenge. Require a
    // challenge control or a strong verification phrase near the page shell.
    const strongPhrase = phrases.slice(0, -1).some(pattern => pattern.test(`${title}\n${text.slice(0, 2500)}`));
    const detected = !!selectorHit || !!strongPhrase;
    return detected ? { detected: true, kind: selectorHit?.includes('captcha') || /captcha|characters you see/i.test(phrase?.source || '') ? 'captcha' : 'bot_challenge', confidence: selectorHit && phrase ? 0.99 : 0.93, indicators: [selectorHit ? 'challenge-control' : '', phrase ? 'verification-text' : ''].filter(Boolean) } : { detected: false, kind: '', confidence: 1, indicators: [] };
  }

  const playRequests = new WeakMap();
  const observedTargets = new Map();
  const discoveredLinks = new Map();
  const stableRefs = new WeakMap();
  const observedSnapshots = new Map();
  const CONTROL_SELECTOR = 'a,button,input:not([type="hidden"]),textarea,select,summary,[role="button"],[role="link"],[role="textbox"],[role="searchbox"],[role="combobox"],[role="checkbox"],[role="radio"],[role="switch"],[role="tab"],[role="menuitem"],[contenteditable="true"]';
  let nextRef = 0, domRevision = 0, geometryRevision = 0, lastGeometryCause = 'initial', lastObservationId = '';
  let mutationTimer = null, scopeCache = null, controlCache = null;
  const observedRoots = new Set();
  const mutationObserver = typeof MutationObserver === 'function' ? new MutationObserver(records => recordMutations(records)) : null;
  function isCaptainNode(node) {
    try { return !!(node?.id === 'captain-agent-host' || node?.id === 'captain-secure-input-host' || node?.closest?.('#captain-agent-host,#captain-secure-input-host')); }
    catch { return false; }
  }
  function recordMutations(records) {
    if (!records?.some(record => {
      if (record.attributeName === 'data-captain-ref' || isCaptainNode(record.target)) return false;
      if (record.type !== 'childList') return true;
      return [...record.addedNodes, ...record.removedNodes].some(node => !isCaptainNode(node));
    })) return;
    // Invalidate immediately. Debouncing only coalesces selector rescans.
    domRevision++;
    scopeCache = controlCache = null;
    if (mutationTimer) clearTimeout(mutationTimer);
    mutationTimer = setTimeout(() => { mutationTimer = null; }, 50);
  }
  function watchRoot(root) {
    if (!mutationObserver || !root || observedRoots.has(root)) return;
    mutationObserver.observe(root, { subtree: true, childList: true, characterData: true, attributes: true,
      attributeFilter: ['aria-label','aria-labelledby','aria-describedby','aria-expanded','aria-hidden','aria-disabled','disabled','hidden','inert','style','class','type','name','placeholder','title','autocomplete','role','href','id','for','tabindex','contenteditable','value'] });
    observedRoots.add(root);
  }
  function flushMutations() { if (mutationObserver) recordMutations(mutationObserver.takeRecords()); }
  function geometryChanged(cause = 'unknown') { geometryRevision++; lastGeometryCause = cause; controlCache = null; }
  function topLevelGeometryChanged(event) {
    // Window capture listeners also see scroll events from every nested
    // carousel and overflow pane. Those do not change the browser viewport;
    // their sensitive descendants are instead covered by the before/after
    // redaction-box proof. Track only a scroll that can expose a different page
    // viewport, then compare the exact page scroll offsets in each lease.
    const target = event?.target;
    if (target && target !== document && target !== document.documentElement && target !== document.body && target !== globalThis) return;
    geometryChanged('page-scroll');
  }
  function windowGeometryChanged() { geometryChanged('window-resize'); }
  function viewportResizeChanged() { geometryChanged('viewport-resize'); }
  function viewportScrollChanged() { geometryChanged('viewport-scroll'); }
  if (realExtension && mutationObserver) {
    watchRoot(document.documentElement || document);
    globalThis.addEventListener?.('scroll', topLevelGeometryChanged, { capture: true, passive: true });
    globalThis.addEventListener?.('resize', windowGeometryChanged, { passive: true });
    globalThis.visualViewport?.addEventListener?.('resize', viewportResizeChanged);
    globalThis.visualViewport?.addEventListener?.('scroll', viewportScrollChanged);
  }
  function controlScopes() {
    if (scopeCache?.revision === domRevision) return scopeCache.scopes;
    const scopes = [{ root: document, framePath: 'top' }], seen = new Set([document]);
    if (realExtension) {
      for (let i = 0; i < scopes.length && scopes.length < 16; i++) {
        const scope = scopes[i];
        watchRoot(scope.root.documentElement || scope.root);
        const descendants = [...(scope.root.querySelectorAll?.('*') || [])].slice(0, 2500);
        let frameIndex = 0, shadowIndex = 0;
        for (const node of descendants) {
          if (isCaptainNode(node)) continue;
          if (node.shadowRoot?.mode === 'open' && !seen.has(node.shadowRoot) && scopes.length < 16) {
            seen.add(node.shadowRoot);
            scopes.push({ root: node.shadowRoot, framePath: `${scope.framePath}/shadow${++shadowIndex}` });
          }
          if (node.tagName !== 'IFRAME' && node.tagName !== 'FRAME') continue;
          const framePath = `${scope.framePath}/frame${++frameIndex}`;
          try {
            const child = node.contentDocument, origin = node.contentWindow?.location?.origin;
            if (child?.documentElement && origin === location.origin && !seen.has(child) && scopes.length < 16) {
              seen.add(child); scopes.push({ root: child, framePath });
              node.contentWindow?.addEventListener?.('scroll', geometryChanged, { passive: true });
              node.contentWindow?.addEventListener?.('resize', geometryChanged, { passive: true });
            }
          } catch { /* Inaccessible frames remain visual-only. */ }
        }
      }
    }
    scopeCache = { revision: domRevision, scopes };
    return scopes;
  }
  function controlsFor(scopes) {
    if (realExtension && controlCache?.revision === domRevision) return controlCache.nodes;
    const nodes = [];
    for (const scope of scopes) {
      for (const el of scope.root.querySelectorAll?.(CONTROL_SELECTOR) || []) {
        if (isCaptainNode(el) || el.type === 'hidden' || nodes.length >= 450) continue;
        if (visible(el)) nodes.push({ el, framePath: scope.framePath });
      }
      if (nodes.length >= 450) break;
    }
    controlCache = { revision: domRevision, nodes };
    return nodes;
  }
  function topRect(el) {
    const source = el.getBoundingClientRect();
    let x = source.x ?? source.left, y = source.y ?? source.top;
    let width = source.width, height = source.height;
    let view = el.ownerDocument?.defaultView;
    for (let depth = 0; view?.frameElement && depth < 4; depth++) {
      const frame = view.frameElement, box = frame.getBoundingClientRect();
      const scaleX = box.width / (view.innerWidth || box.width || 1), scaleY = box.height / (view.innerHeight || box.height || 1);
      x = (box.x ?? box.left) + x * scaleX; y = (box.y ?? box.top) + y * scaleY;
      width *= scaleX; height *= scaleY;
      view = frame.ownerDocument?.defaultView;
    }
    return { x, y, width, height };
  }
  function safeLabel(el) {
    const direct = el.getAttribute?.('aria-label') || '';
    const refs = (el.getAttribute?.('aria-labelledby') || '').trim().split(/\s+/).slice(0, 4);
    const root = el.getRootNode?.() || el.ownerDocument;
    const linked = refs.map(id => {
      if (!/^[\w-]{1,100}$/.test(id)) return '';
      return root?.getElementById?.(id)?.innerText || el.ownerDocument?.getElementById?.(id)?.innerText || '';
    }).filter(Boolean).join(' ');
    const associated = el.labels ? [...el.labels].slice(0, 3).map(label => label.innerText || '') : [];
    return { ariaLabel: direct.slice(0, 240), associatedLabel: [linked, ...associated].filter(Boolean).join(' ').slice(0, 240),
      text: [direct, linked, ...associated, el.title || '', el.getAttribute?.('alt') || ''].filter(Boolean).join(' ').slice(0, 240) };
  }
  function nearbyFormText(el) {
    const group = el.closest?.('fieldset,[role="group"],[role="search"],form');
    if (!group) return '';
    const labels = [...(group.querySelectorAll?.('legend,label,h1,h2,h3,[role="heading"]') || [])].slice(0, 6);
    return redact([group.getAttribute?.('aria-label') || '', ...labels.filter(visible).map(node => node.innerText || '')].filter(Boolean).join(' ')).text.slice(0, 180);
  }
  function controlSignature(el, framePath) {
    const box = topRect(el);
    return JSON.stringify([framePath, el.tagName, el.type || '', el.getAttribute?.('role') || '', safeLabel(el).text,
      el.getAttribute?.('aria-disabled') || '', !!el.disabled, el.getAttribute?.('href') || '',
      Math.round(box.x), Math.round(box.y), Math.round(box.width), Math.round(box.height)]);
  }
  function displayedResultOrigin(el) {
    // Google may use an opaque /goto link. The visible result still includes a
    // cited address: navigate only its complete HTTPS origin, never decode or
    // guess the opaque token, and never turn a shortened hostname into a URL.
    if (location.hostname !== 'www.google.com' || location.pathname !== '/search' || !el.closest?.('#search, #rso') || el.closest?.('#tads, #tadsb, #bottomads, [data-text-ad], [data-ad-client], [aria-label="Ads"], [aria-label="Sponsored"]')) return null;
    const cite = el.querySelector?.('cite'), heading = el.querySelector?.('h3');
    if (!cite || !heading || !visible(cite) || !visible(heading)) return null;
    const match = (cite.innerText || cite.textContent || '').trim().match(/^https:\/\/([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,})(?=\s|\/|$)/i);
    if (!match) return null;
    try {
      const link = new URL(el.href), address = new URL(`https://${match[1]}/`);
      if (link.origin !== 'https://www.google.com' || link.username || link.password || !['/goto', '/url'].includes(link.pathname) || address.hostname.includes('..')) return null;
      return address;
    } catch { return null; }
  }
  const MEDIA_ERRORS = { 1: 'Media loading was aborted.', 2: 'The player could not download its media.', 3: 'The browser could not decode this media.', 4: 'This media format or source is unavailable.' };
  function mediaError(media) {
    return media?.error ? { code: media.error.code || 0, message: MEDIA_ERRORS[media.error.code] || 'The media player reported an error.' } : null;
  }
  function mediaSource(media) { return media.currentSrc || media.src || media.srcObject || media.querySelector?.('source[src]')?.src || ''; }
  function primaryMedia() {
    const all = [...document.querySelectorAll('video,audio')];
    const onYoutube = /(^|\.)youtube\.com$/.test(location.hostname || '');
    // YouTube keeps empty/hidden player elements around. Observation and actions
    // must agree on the actual main player rather than whichever video is first.
    const main = onYoutube ? all.filter(media => media.closest?.('#movie_player')) : [];
    const candidates = main.length ? main : all;
    return candidates.map(media => ({ media, score: (mediaSource(media) ? 16 : 0) + (visible(media) ? 8 : 0) + (!media.paused ? 2 : 0) + (media.readyState >= 2 ? 1 : 0) }))
      .filter(({ media }) => mediaSource(media) || visible(media))
      .sort((a, b) => b.score - a.score)[0]?.media || null;
  }
  function playControl(media) {
    const player = media.closest?.('#movie_player');
    if (!player) return null;
    return [...player.querySelectorAll('.ytp-play-button, .ytp-large-play-button')].find(button => {
      const label = `${button.getAttribute('aria-label') || ''} ${button.title || ''}`;
      return visible(button) && !/\bpause\b/i.test(label) && !button.disabled;
    }) || null;
  }
  function playbackClick(media) {
    const button = playControl(media), box = button?.getBoundingClientRect();
    return box ? { ok: false, requiresPlayClick: { x: box.x + box.width / 2, y: box.y + box.height / 2 } } : { ok: false, error: 'Playback needs a click on the visible page player.' };
  }

  function amazonPrice(root) {
    const labels = [...root.querySelectorAll('.a-price .a-offscreen,.a-price,[data-a-color="price"]')]
      .map(el => el.getAttribute('aria-label') || el.textContent || '');
    for (const label of labels) {
      const match = label.match(/(?:₹|INR\s*)\s*([\d,]+(?:\.\d{1,2})?)/i);
      const value = Number(match?.[1]?.replaceAll(',', ''));
      if (Number.isFinite(value) && value > 0) return value;
    }
    return null;
  }
  function amazonDirectLink(card, asin) {
    return [...card.querySelectorAll('a[href]')].find(anchor => {
      try {
        const url = new URL(anchor.href);
        return url.protocol === 'https:' && /(^|\.)amazon\.in$/i.test(url.hostname) && new RegExp(`/(?:dp|gp/product)/${asin}(?:/|$)`, 'i').test(url.pathname);
      } catch { return false; }
    }) || null;
  }
  function amazonProducts(elements) {
    if (!/(^|\.)amazon\.in$/i.test(location.hostname) || location.pathname !== '/s') return [];
    const roots = [...new Set([
      ...document.querySelectorAll('[data-component-type="s-search-result"][data-asin]'),
      ...document.querySelectorAll('[data-asin]:not([data-asin=""])')
    ])];
    const byAsin = new Map();
    let position = 0;
    for (const card of roots) {
      const box = card.getBoundingClientRect();
      if (box.width <= 0 || box.height <= 0) continue;
      const asin = (card.getAttribute('data-asin') || '').toUpperCase();
      if (!/^[A-Z0-9]{10}$/.test(asin)) continue;
      const link = amazonDirectLink(card, asin);
      const heading = card.querySelector('h2,[role="heading"]');
      const titleResult = redact(heading?.innerText || link?.innerText || link?.getAttribute('aria-label') || '');
      const title = titleResult.found.length ? '' : titleResult.text.replace(/\s+/g, ' ').trim().slice(0, 240);
      const price = amazonPrice(card);
      const text = card.innerText || '';
      const ratingLabel = [...card.querySelectorAll('[aria-label]')].map(el => el.getAttribute('aria-label') || '').find(value => /[1-5](?:\.\d)?\s+out of 5/i.test(value)) || '';
      const rating = Number(ratingLabel.match(/([1-5](?:\.\d)?)\s+out of 5/i)?.[1]);
      const reviewCountText = ratingLabel.match(/from\s+([\d,]+)\s+(?:ratings|reviews)/i)?.[1]
        || [...card.querySelectorAll('a[href*="customerReviews" i],a[href*="#customerReviews" i],[aria-label*="ratings" i],[aria-label*="reviews" i]')]
          .map(el => el.getAttribute('aria-label') || el.textContent || '').map(value => value.match(/([\d,]+)/)?.[1]).find(Boolean)
        || text.match(/\b([\d,]+)\s+(?:ratings|reviews)\b/i)?.[1] || '';
      const ratingCount = reviewCountText ? Number(reviewCountText.replaceAll(',', '')) : null;
      const sponsored = /\bSponsored\b/i.test(text) || !!card.querySelector('[aria-label*="Sponsored" i],[data-component-type*="sp-sponsored" i],a[href*="adId=" i],a[href*="aax" i]');
      const availabilityResult = redact(card.querySelector('[class*="availability" i],.a-color-success')?.textContent || '');
      let ref = '';
      if (link) {
        ref = [...observedTargets].find(([, element]) => element === link)?.[0] || '';
        if (!ref) {
          ref = realExtension ? stableRefs.get(link) : '';
          if (!ref) { ref = `c${realExtension ? ++nextRef : elements.length + 1}`; if (realExtension) stableRefs.set(link, ref); }
          observedTargets.set(ref, link); if (link.dataset) link.dataset.captainRef = ref;
          observedSnapshots.set(ref, { element: link, framePath: 'top', signature: controlSignature(link, 'top') });
          elements.push({ ref, tag: 'a', role: link.getAttribute('role') || '', type: '', name: title, value: '', placeholder: '', groupText: `${title}\n₹${price || ''}`, href: `https://www.amazon.in/dp/${asin}`, disabled: false, sensitive: false, sensitiveType: '', bbox: { x: box.x, y: box.y, width: box.width, height: box.height }, state: {}, confidence: 1, source: 'AMAZON_SEMANTIC_DOM' });
        }
      }
      position++;
      const evidence = [asin, link, title, price, card.matches('[data-component-type="s-search-result"]')].filter(Boolean).length;
      const candidate = { asin, title, price, currency: price ? 'INR' : '', rating: Number.isFinite(rating) ? rating : null, ratingCount: Number.isFinite(ratingCount) ? ratingCount : null, url: link ? `https://www.amazon.in/dp/${asin}` : '', availability: availabilityResult.found.length ? '' : availabilityResult.text.trim().slice(0, 100), sponsored, position, confidence: Math.min(1, evidence / 5), ref, bbox: { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) } };
      const previous = byAsin.get(asin);
      if (!previous || candidate.confidence > previous.confidence || (candidate.confidence === previous.confidence && candidate.title.length > previous.title.length)) byAsin.set(asin, candidate);
    }
    return [...byAsin.values()].slice(0, 80);
  }
  function amazonDetail() {
    if (!/(^|\.)amazon\.in$/i.test(location.hostname)) return null;
    const asin = location.pathname.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:\/|$)/i)?.[1]?.toUpperCase();
    if (!asin) return null;
    const titleResult = redact(document.querySelector('#productTitle,h1')?.textContent || '');
    const root = document.querySelector('#centerCol,#dp-container,main') || document;
    const price = amazonPrice(root);
    return { asin, title: titleResult.found.length ? '' : titleResult.text.replace(/\s+/g, ' ').trim().slice(0, 240), price, currency: price ? 'INR' : '', url: `https://www.amazon.in/dp/${asin}` };
  }

  function currentSearchQuery() {
    const params = new URL(location.href).searchParams;
    for (const key of ['search_query', 'q', 'query', 'field-keywords', 'keyword', 'keywords', 'k', 'search']) {
      const value = params.get(key);
      if (value) return redact(value).text;
    }
    return '';
  }
  function safePageUrl() {
    try {
      const url = new URL(location.href);
      const result = redact(`${url.origin}${url.pathname}`);
      const decodedPath = redact(decodeURIComponent(url.pathname));
      if (realExtension && (url.username || url.password || result.blocked || result.found.length || decodedPath.blocked || decodedPath.found.length)) {
        throw new Error('Private page URL');
      }
      return result.text;
    } catch {
      if (realExtension) throw new Error('Page URL cannot be safely observed.');
      return `${location.origin}${location.pathname}`;
    }
  }

  // This signal never leaves the extension. It lets the service worker wait for
  // a usable page without running a second full extraction/privacy pass.
  function readiness() {
    requirePrivacy();
    // Apply queued DOM/geometry changes before reporting the local readiness
    // lease. This metadata is extension-internal only; it is never projected
    // to the planner or persisted in the user-visible panel state.
    flushMutations();
    const cards = [...document.querySelectorAll('[data-component-type="s-search-result"][data-asin]')];
    const amazonResults = /(^|\.)amazon\.in$/i.test(location.hostname) && location.pathname === '/s';
    return {
      url: safePageUrl(),
      searchQuery: currentSearchQuery(),
      documentReadyState: document.readyState,
      meaningfulContent: (document.body?.innerText?.trim().length || 0) > 80,
      documentToken,
      domRevision,
      geometryRevision,
      amazonResultCards: cards.filter(card => card.getAttribute('data-asin')).length,
      amazonResultSignature: cards.slice(0, 30).map(card => `${card.getAttribute('data-asin')}:${redact(card.querySelector('.a-price .a-offscreen')?.textContent || '').text}`).join('|'),
      ready: amazonResults ? cards.length >= 3 : document.readyState !== 'loading'
    };
  }

  // This is a local pre-capture pacing signal, not a privacy proof and never
  // leaves the extension.  It deliberately returns only revisions, viewport
  // dimensions, an opaque structural digest and a box count.  The service
  // worker still performs the full before/after capture lease comparison with
  // the actual boxes before a screenshot can be released.
  async function visualStability() {
    const observation = await observe(true);
    const lease = observation.pageMetadata || {};
    const structural = JSON.stringify(observation.redactionBoxes || []);
    let digest = 2166136261;
    for (const char of structural) { digest ^= char.charCodeAt(0); digest = Math.imul(digest, 16777619); }
    return {
      ok: true,
      url: observation.url,
      documentToken: lease.documentToken,
      domRevision: lease.domRevision,
      geometryRevision: lease.geometryRevision,
      viewport: observation.viewport,
      redactionCount: observation.redactionBoxes?.length || 0,
      redactionDigest: (digest >>> 0).toString(16).padStart(8, '0'),
      visibleTextDigest: lease.visibleTextHash,
      controlDigest: lease.domFingerprint
    };
  }

  async function observe(requireVisualCoverage = false) {
    observationStage = 'readiness';
    requirePrivacy();
    const observationStarted = now();
    // Amazon paints the result shell before organic cards. Observe only after a
    // bounded local readiness check so the planner does not spend action steps
    // racing the page. A block/CAPTCHA page still returns after this deadline.
    if (/(^|\.)amazon\.in$/i.test(location.hostname) && location.pathname === '/s') {
      const deadline = now() + 3000;
      let previous = '', stableSamples = 0;
      while (now() < deadline) {
        const cards = [...document.querySelectorAll('[data-component-type="s-search-result"][data-asin]')];
        const signature = cards.slice(0, 30).map(card => `${card.getAttribute('data-asin')}:${redact(card.querySelector('.a-price .a-offscreen')?.textContent || '').text}`).join('|');
        // Amazon retains hidden/below-fold spinner nodes after the organic grid
        // is usable. Stable product identities and prices are the stronger signal.
        stableSamples = signature && signature === previous && cards.length >= 3 ? stableSamples + 1 : 0;
        previous = signature;
        if (stableSamples >= 2) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    // Coalesce bursts from SPA rerenders before doing the bounded selector
    // walk. Revisions were invalidated immediately, so action checks never
    // wait for this observation-only debounce.
    if (realExtension && mutationTimer) await new Promise(resolve => setTimeout(resolve, 55));
    const readinessMs = now() - observationStarted;
    flushMutations();
    if (realExtension && (!documentToken || !mutationObserver)) throw new Error('Safe document identity or mutation tracking is unavailable.');
    lastObservationId = '';
    const revisionAtStart = domRevision, geometryAtStart = geometryRevision;
    // Large commerce pages put result-card links well after their global header.
    // Keep the normal observation budget small, but allow enough locally-read
    // controls on Amazon for grounded product comparison. Nothing here leaves
    // the device until the redaction pass below has completed.
    const observationLimit = /(^|\.)amazon\.in$/i.test(location.hostname) ? 360 : 180;
    const nodes = controlsFor(controlScopes()).slice(0, observationLimit);
    const privacyStarted = now(), boxes = [];
    const counts = {};
    observationStage = 'text-masks';
    const textMasks = sensitiveTextRegions(controlScopes(), requireVisualCoverage);
    observationStage = 'visual-masks';
    for (const box of [...textMasks, ...uninspectableVisualRegions(controlScopes(), requireVisualCoverage)]) {
      boxes.push(box); counts[box.kind] = (counts[box.kind] || 0) + 1;
    }
    const privacyRegionMs = now() - privacyStarted;
    observedTargets.clear();
    observedSnapshots.clear();
    discoveredLinks.clear();
    const elementStarted = now();
    observationStage = 'controls';
    const elements = nodes.map(({ el, framePath }, index) => {
      let ref = realExtension ? stableRefs.get(el) : '';
      if (!ref) { ref = `c${realExtension ? ++nextRef : index + 1}`; if (realExtension) stableRefs.set(el, ref); }
      observedTargets.set(ref, el);
      if (el.dataset) el.dataset.captainRef = ref;
      const labels = safeLabel(el), label = labels.text;
      const type = el.type || el.getAttribute?.('type') || '';
      const raw = [label, el.placeholder, el.innerText, type === 'search' ? el.value : ''].filter(Boolean).join(' ').trim().slice(0, 240);
      const sensitiveType = sensitiveInputType(el);
      const sensitive = !!sensitiveType || el.type === 'password' || SECRET_HINT.test(`${label} ${el.name} ${el.autocomplete}`);
      const result = sensitive ? (realExtension ? redact(raw || 'private field', { kind: sensitiveType || 'secret' }) : { text: '[REDACTED_SECRET]', found: ['SECRET'] }) : redact(raw);
      if (result.found.length) {
        const r = topRect(el);
        boxes.push({ x: Math.max(0, r.x), y: Math.max(0, r.y), width: r.width, height: r.height, kind: result.found[0] });
        result.found.forEach((kind) => counts[kind] = (counts[kind] || 0) + 1);
      }
      observationStage = 'control-links';
      let href = el.href ? safeNavigationHref(el.href) : '';
      // A retained mini-player or recommendation can appear before actual results.
      if (location.hostname === 'www.youtube.com' && location.pathname === '/results' && /\/watch\b/.test(href) && !el.closest('ytd-search')) href = '';
      const rect = topRect(el);
      observationStage = 'control-context';
      const group = el.closest('article,[role="listitem"],li,.product,.card,[data-product],[data-component-type="s-search-result"],[data-asin]');
      const nearbyText = sensitive ? '' : nearbyFormText(el);
      const groupText = sensitive ? '' : [group && group !== el ? redact(group.innerText || '').text.slice(0, 300) : '', nearbyText].filter(Boolean).join(' ').slice(0, 500);
      const exposedValue = ['search','range','number'].includes(type) || el.tagName === 'SELECT' ? el.value : '';
      const publicValue = sensitive ? '[REDACTED_SECRET]' : redact(exposedValue || '').text.slice(0, 500);
      const options = el.tagName === 'SELECT' && !sensitive ? [...el.options].slice(0, 60).map(option => ({ text: redact(option.textContent || '').text.trim().slice(0, 120), value: redact(option.value || '').text.slice(0, 180), selected: option.selected })) : undefined;
      const disabled = !!(el.disabled || el.closest?.('fieldset[disabled]') || el.getAttribute?.('aria-disabled') === 'true' || el.closest?.('[inert]'));
      const safe = text => redact(text || '').text;
      const element = { ref, tag: el.tagName.toLowerCase(), role: el.getAttribute('role') || '', type,
        name: result.text, accessibleName: safe(label).slice(0, 240), associatedLabel: safe(labels.associatedLabel).slice(0, 240),
        ariaLabel: safe(labels.ariaLabel).slice(0, 240), autocomplete: safe(el.autocomplete || el.getAttribute?.('autocomplete')).slice(0, 80),
        inputMode: safe(el.inputMode || el.getAttribute?.('inputmode')).slice(0, 40), nearbyText, framePath,
        visible: true, enabled: !disabled, value: publicValue, placeholder: safe(el.placeholder).slice(0, 240), groupText,
        href, disabled, sensitive, sensitiveType: sensitiveType || (sensitive ? 'secret' : ''), bbox: rect,
        state: { checked: !!el.checked, selected: el.selectedIndex ?? null, expanded: el.getAttribute('aria-expanded'), readonly: !!el.readOnly, options }, confidence: 1, source: 'dom' };
      observedSnapshots.set(ref, { element: el, framePath, signature: controlSignature(el, framePath), rect });
      return element;
    });
    const domExtractionMs = now() - elementStarted;
    const amazonStarted = now(), extractedAmazonProducts = amazonProducts(elements);
    const amazonExtractionMs = now() - amazonStarted;
    const searchResults = [];
    // Discovery uses observed organic result headings, not arbitrary page links
    // or text claiming to be instructions. Keep original links local to refs.
    if (location.hostname === 'www.google.com' && location.pathname === '/search') {
      const seen = new Set();
      for (const [ref, el] of observedTargets) {
        if (el.tagName !== 'A' || !el.closest?.('#search, #rso')) continue;
        if (el.closest?.('#tads, #tadsb, #bottomads, [data-text-ad], [data-ad-client], [aria-label="Ads"], [aria-label="Sponsored"]')) continue;
        const heading = el.querySelector?.('h3');
        if (!heading || !visible(heading)) continue;
        try {
          const direct = new URL(el.href), displayed = displayedResultOrigin(el);
          const url = displayed || direct;
          if (url.protocol !== 'https:' || url.username || url.password || /(^|\.)(?:google\.com|googleadservices\.com|doubleclick\.net|googleusercontent\.com)$/.test(url.hostname)) continue;
          const safeHref = redact(`${url.origin}${url.pathname}`), title = redact(heading.innerText || heading.textContent || '');
          if (safeHref.blocked || safeHref.found.length || redact(decodeURIComponent(url.pathname)).found.length || title.blocked || title.found.length || !title.text.trim() || seen.has(safeHref.text)) continue;
          seen.add(safeHref.text);
          if (displayed) {
            discoveredLinks.set(ref, { originalHref: el.href, origin: displayed.origin });
            elements.find(item => item.ref === ref).href = safeHref.text;
          }
          searchResults.push({ ref, title: title.text.trim().slice(0, 240), href: safeHref.text, ...(displayed ? { source: 'displayed-origin' } : {}) });
        } catch {}
      }
    }
    // Never exceed the shared core's bounded 16,384-character input. The
    // trailing page text is excluded from the observation, not emitted raw.
    observationStage = 'page-text';
    const textStarted = now(), pageText = redact(document.body?.innerText?.slice(0, 16000) || '');
    pageText.found.forEach((kind) => counts[kind] = (counts[kind] || 0) + 1);
    const media = primaryMedia();
    observationStage = 'text-regions';
    const textRegions = [...document.querySelectorAll('h1,h2,h3,p,th,td,label,[role="heading"]')].filter(visible).slice(0, 100).map((el, index) => {
      const rect = el.getBoundingClientRect(), result = redact(el.innerText || el.textContent || '');
      return { id: `t${index + 1}`, role: el.getAttribute('role') || (/^H[1-6]$/.test(el.tagName) ? 'heading' : el.tagName === 'LABEL' ? 'label' : 'text'), text: result.text.trim().slice(0, 300), bbox: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, state: {}, confidence: 1, source: 'DOM' };
    }).filter(region => region.text);
    observationStage = 'visual-regions';
    const visualRegions = [...document.querySelectorAll('img,canvas,video,iframe,frame,embed,object,[role="img"],article,[role="dialog"],[role="menu"]')].filter(visible).slice(0, 80).map((el, index) => {
      const rect = topRect(el), label = redact(el.getAttribute('aria-label') || el.alt || el.getAttribute('role') || el.tagName.toLowerCase());
      const semanticContainer = el.tagName === 'ARTICLE' || ['dialog', 'menu'].includes(el.getAttribute('role'));
      const opaque = ['CANVAS','IFRAME','FRAME','EMBED','OBJECT'].includes(el.tagName);
      return { id: `v${index + 1}`, role: el.getAttribute('role') || el.tagName.toLowerCase(),
        text: opaque ? 'visual-only unknown content' : label.text.slice(0, 160),
        bbox: rect, state: {}, confidence: opaque ? 0 : semanticContainer ? 0.9 : 0.8, source: 'VISION_GEOMETRY' };
    });
    observationStage = 'lease';
    const challenge = detectHumanChallenge();
    const textAndMetadataMs = now() - textStarted;
    const hash = value => { let result = 2166136261; for (const char of String(value)) { result ^= char.charCodeAt(0); result = Math.imul(result, 16777619); } return (result >>> 0).toString(16).padStart(8, '0'); };
    flushMutations();
    if (realExtension && (domRevision !== revisionAtStart || (requireVisualCoverage && geometryRevision !== geometryAtStart)))
      throw new Error('Page changed during perception; repeat the observation.');
    const observationId = opaqueToken();
    if (realExtension && !observationId) throw new Error('Observation identity unavailable.');
    lastObservationId = observationId;
    const pageMetadata = {
      domFingerprint: hash(elements.map(el => `${el.tag}:${el.role}:${el.name}:${Math.round(el.bbox.x)}:${Math.round(el.bbox.y)}`).join('|')),
      visibleTextHash: hash(pageText.text), elementCount: elements.length,
      meaningfulContent: elements.length > 0 || pageText.text.trim().length > 80,
      capturedAt: Date.now(), documentToken, domRevision, geometryRevision, geometryCause: lastGeometryCause, observationId
    };
    if (requireVisualCoverage && realExtension && (boxes.length > 500 || !Number.isFinite(innerWidth) || !Number.isFinite(innerHeight) ||
      innerWidth <= 0 || innerHeight <= 0 || !Number.isFinite(devicePixelRatio) || devicePixelRatio <= 0)) {
      throw new Error(PRIVATE_OBSERVATION_ERROR);
    }
    const observation = {
      site: location.hostname === 'www.youtube.com' || location.hostname === 'youtube.com' ? 'youtube' : '',
      searchQuery: currentSearchQuery(),
      url: safePageUrl(),
      title: redact(document.title).text,
      viewport: { width: innerWidth, height: innerHeight, devicePixelRatio,
        scrollX: Math.round(Number(globalThis.scrollX) || 0), scrollY: Math.round(Number(globalThis.scrollY) || 0),
        visualOffsetX: Math.round(Number(globalThis.visualViewport?.offsetLeft) || 0),
        visualOffsetY: Math.round(Number(globalThis.visualViewport?.offsetTop) || 0),
        visualScale: Number.isFinite(globalThis.visualViewport?.scale) ? globalThis.visualViewport.scale : 1 },
      pageText: pageText.text.slice(0, 9000),
      elements,
      amazonProducts: extractedAmazonProducts,
      amazonProductDetail: amazonDetail(),
      textRegions,
      visualRegions,
      interactiveRegions: elements,
      ocr: { status: 'not-configured', regions: [], cached: false, note: 'No packaged local OCR model is installed.' },
      sensitiveRegions: boxes.map((box, index) => ({ id: `s${index + 1}`, type: box.kind, bbox: { x: box.x, y: box.y, width: box.width, height: box.height }, confidence: 1, source: 'DOM_PRIVACY' })),
      confidence: { dom: 1, geometry: 0.8, ocr: 0 },
      localTiming: { readinessMs: Math.round(readinessMs), privacyRegionMs: Math.round(privacyRegionMs), domExtractionMs: Math.round(domExtractionMs), accessibilityExtractionMs: Math.round(domExtractionMs), amazonExtractionMs: Math.round(amazonExtractionMs), textAndMetadataMs: Math.round(textAndMetadataMs), totalDomObservationMs: Math.round(now() - observationStarted), ocrMs: 0 },
      pageMetadata,
      challenge,
      searchResults: searchResults.slice(0, 12),
      redactionBoxes: boxes,
      piiCounts: counts,
      media: media ? [{ paused: media.paused, ended: media.ended, readyState: media.readyState, networkState: media.networkState, currentTime: Math.round(media.currentTime * 1000) / 1000, visible: visible(media), pageVisible: document.visibilityState === 'visible', error: mediaError(media), primary: true }] : [],
      vision: { interactiveRegions: elements.length, imageCount: [...document.images].filter(visible).length, mediaCount: document.querySelectorAll('video,audio').length, mode: 'DOM+local-visual-geometry' }
    };
    // This catches blocks inside optional extraction paths that swallowed a
    // thrown privacy error. No partial observation can cross the message port.
    requirePrivacy();
    observationStage = 'complete';
    return observation;
  }

  function target(spec = {}, allowObservedOffscreen = false) {
    if (spec.ref) {
      const el = observedTargets.get(spec.ref);
      const snapshot = observedSnapshots.get(spec.ref);
      if (realExtension && (!snapshot || snapshot.element !== el ||
        controlSignature(el, snapshot.framePath) !== snapshot.signature ||
        el.disabled || el.getAttribute?.('aria-disabled') === 'true' || el.closest?.('[inert],fieldset[disabled]'))) return null;
      return el && el.isConnected && (allowObservedOffscreen || visible(el)) ? el : null;
    }
    const needle = (spec.text || spec.name || '').toLowerCase();
    return [...document.querySelectorAll('a,button,input,textarea,select,[role]')].find((el) => `${el.innerText} ${el.value} ${el.placeholder} ${el.ariaLabel}`.toLowerCase().includes(needle));
  }

  function requestLocalInput(el, inputType) {
    return new Promise(resolve => {
      document.querySelector('#captain-secure-input-host')?.remove();
      // Keep even the legacy on-device secure-input fallback compact. It must
      // never cover the site; the normal privacy gate blocks this path first.
      const host = document.createElement('div'); host.id = 'captain-secure-input-host'; host.style.cssText = 'all:initial;position:fixed;left:8px;top:8px;z-index:2147483647;color-scheme:dark';
      const root = host.attachShadow({ mode: 'closed' });
      root.innerHTML = `<style>:host{all:initial}.shade{font:13px system-ui;color:#fafafa}.box{width:min(366px,calc(100vw - 16px));max-width:366px;background:#121216;border:1px solid #ff435d;border-radius:16px;padding:16px;box-shadow:0 20px 80px #000}.title{font-size:15px;font-weight:800}.note{color:#bbb;line-height:1.45;margin:7px 0 12px;font-size:11px}input{box-sizing:border-box;width:100%;padding:10px;border-radius:9px;border:1px solid #555;background:#070709;color:#fff;font:inherit}footer{display:flex;justify-content:flex-end;gap:9px;margin-top:12px}button{padding:8px 11px;border:0;border-radius:9px;font-weight:700}.cancel{background:#2d2d32;color:#fff}.confirm{background:#ff435d;color:#fff}</style><div class="shade"><form class="box"><div class="title">Local secure input</div><div class="note">Sensitive input is required locally.</div><input type="password" autocomplete="off" spellcheck="false" aria-label="Local secure value"><footer><button class="cancel" type="button">Cancel</button><button class="confirm" type="submit">Insert locally</button></footer></form></div>`;
      const input = root.querySelector('input');
      const finish = result => { input.value = ''; host.remove(); resolve(result); };
      root.querySelector('.cancel').onclick = () => finish({ ok: false, error: 'Local secure input was cancelled.' });
      root.querySelector('form').onsubmit = event => {
        event.preventDefault(); const value = input.value; if (!value) return input.focus();
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
        setter ? setter.call(el, value) : el.value = value;
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: null }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        finish({ ok: true, localOnly: true });
      };
      root.querySelector('.shade').onkeydown = event => { if (event.key === 'Escape') finish({ ok: false, error: 'Local secure input was cancelled.' }); };
      document.documentElement.append(host); input.focus();
    });
  }

  async function execute(action) {
    if (action.type === 'verifyPlayback') {
      const media = primaryMedia();
      const failure = mediaError(media);
      if (failure) return { ok: false, error: failure.message };
      if (!media) return { ok: false, retryable: true, error: 'Waiting for the requested player to appear.' };
      if (document.querySelector('.ad-showing')) return { ok: false, retryable: true, error: 'Waiting for the advertisement to finish before confirming the requested video.' };
      const words = ((action.query || '').normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter(word => !['a','the','by','song','songs','music','video','videos','please'].includes(word));
      const title = document.title.toLowerCase();
      const titleWords = new Set(title.normalize('NFKC').match(/[\p{L}\p{N}]+/gu) || []);
      if (words.length && !words.every(word => titleWords.has(word))) return { ok: false, error: 'The selected video title does not match the requested song and artist. Playback is not confirmed.' };
      if (media.ended) return { ok: false, error: 'The video ended before playback could be verified.' };
      if (media.paused || media.readyState < 2) return { ok: false, retryable: true, needsResume: media.paused && !!mediaSource(media), error: media.paused ? 'The requested player is paused.' : 'Playback has not started or is buffering.' };
      const before = media.currentTime;
      const source = mediaSource(media);
      const pageUrl = location.href;
      await new Promise(resolve => setTimeout(resolve, 2200));
      return primaryMedia() === media && mediaSource(media) === source && location.href === pageUrl && document.title.toLowerCase() === title && !mediaError(media) && !media.paused && !media.ended && media.currentTime > before + 0.5 && !document.querySelector('.ad-showing') ? { ok: true, verified: true } : { ok: false, retryable: true, error: 'The playback clock is not advancing. The player may be buffering or have changed.' };
    }
    if (action.type === 'media') {
      const media = primaryMedia();
      if (!media) return { ok: false, error: 'No audio or video was found on this page.' };
      try {
        if (action.operation === 'pause') { playRequests.delete(media); media.pause(); }
        else {
          const failure = mediaError(media);
          if (failure) return { ok: false, error: failure.message };
          let request = playRequests.get(media);
          if (request && request.source !== mediaSource(media)) { playRequests.delete(media); request = null; }
          if (!request && !media.paused && !media.ended) return media.readyState >= 2 ? { ok: true } : { ok: true, pending: document.visibilityState === 'hidden' ? 'The player is waiting in a background tab.' : 'Player is buffering; waiting for media data.' };
          if (!request) {
            request = { source: mediaSource(media) };
            request.promise = Promise.resolve(media.play()).then(() => 'playing');
            playRequests.set(media, request);
            const release = () => { if (playRequests.get(media) === request) playRequests.delete(media); };
            request.promise.then(release, release);
          }
          let timer;
          try {
            const outcome = await Promise.race([request.promise, new Promise(resolve => { timer = setTimeout(() => resolve('loading'), 5000); })]);
            if (outcome === 'loading') return { ok: true, pending: 'Player is buffering; verifying on next observation' };
          } finally { clearTimeout(timer); }
        }
      }
      catch (error) {
        if (error.name === 'NotAllowedError') {
          return playbackClick(media);
        }
        if (error.name === 'AbortError') return { ok: true, pending: 'Player is still loading' };
        return { ok: false, error: `Player error: ${error.name}: ${error.message}` };
      }
      return { ok: !media.paused || action.operation === 'pause' };
    }
    if (action.type === 'finish') return { ok: true, done: true, message: action.message };
    if (action.type === 'wait') { await new Promise((r) => setTimeout(r, Math.min(action.ms || 800, 3000))); return { ok: true }; }
    if (action.type === 'navigate') { setTimeout(() => location.assign(action.url), 60); return { ok: true, navigated: true }; }
    if (action.type === 'back') { setTimeout(() => history.back(), 60); return { ok: true, navigated: true }; }
    if (action.type === 'scroll') { scrollBy({ top: action.direction === 'up' ? -(action.amount || 600) : (action.amount || 600), behavior: 'smooth' }); return { ok: true }; }
    const el = target(action.target, !!action.expectedAsin);
    if (!el) return { ok: false, error: 'Target not found' };
    const localSensitiveType = sensitiveInputType(el);
    if (action.type === 'request_local_input') {
      if (!localSensitiveType) return { ok: false, error: 'The selected target is not a sensitive field.' };
      return requestLocalInput(el, action.inputType || localSensitiveType);
    }
    if (localSensitiveType && ['type', 'select', 'press', 'submit'].includes(action.type)) return { ok: false, error: 'Remote control of a sensitive field was blocked. Use local secure input.' };
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    if (action.type === 'click') {
      const link = el.closest('a[href]');
      if (action.expectedAsin) {
        let destination;
        try { destination = new URL(link?.href); } catch {}
        const actualAsin = destination?.pathname.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:\/|$)/i)?.[1]?.toUpperCase();
        const expectedAsin = String(action.expectedAsin).toUpperCase();
        if (!destination || destination.protocol !== 'https:' || destination.hostname.replace(/^www\./, '') !== 'amazon.in' || actualAsin !== expectedAsin || destination.username || destination.password) return { ok: false, error: 'The Amazon product identity or direct URL changed before selection. No navigation was sent.' };
        const canonical = `https://www.amazon.in/dp/${expectedAsin}`;
        if (action.expectedUrl && action.expectedUrl !== canonical) return { ok: false, error: 'The planned Amazon product URL was not canonical. No navigation was sent.' };
        return { ok: true, navigateUrl: canonical };
      }
      const discovered = discoveredLinks.get(action.target?.ref);
      if (action.expectedHost && discovered) {
        const displayed = displayedResultOrigin(el);
        if (!displayed || !link || link.href !== discovered.originalHref || displayed.origin !== discovered.origin || displayed.hostname !== action.expectedHost) return { ok: false, error: 'The displayed website address changed. No navigation was sent.' };
        return { ok: true, navigateUrl: displayed.href };
      }
      if (action.expectedHost) {
        let destination;
        try { destination = new URL(link?.href); } catch {}
        if (!destination || destination.protocol !== 'https:' || destination.username || destination.password || destination.port || destination.hostname !== action.expectedHost) return { ok: false, error: 'The discovered link changed before it could be opened. No navigation was sent.' };
      }
      if (link && /^https?:/.test(link.href)) {
        const destination = new URL(link.href);
        if (destination.hostname === 'www.youtube.com' && destination.pathname === '/watch') {
          for (const key of [...destination.searchParams.keys()]) if (key !== 'v') destination.searchParams.delete(key);
        }
        return { ok: true, navigateUrl: destination.href };
      }
      el.click(); return { ok: true };
    }
    if (action.type === 'submit') { el.form?.requestSubmit?.(); return { ok: true }; }
    if (action.type === 'press') {
      el.focus();
      if (action.key === 'Enter' && el.form) setTimeout(() => el.form.requestSubmit(), 50);
      else for (const kind of ['keydown', 'keyup']) el.dispatchEvent(new KeyboardEvent(kind, { key: action.key, bubbles: true }));
      return { ok: true, navigated: action.key === 'Enter' };
    }
    if (action.type === 'select') { el.value = action.value; el.dispatchEvent(new Event('change', { bubbles: true })); return { ok: true }; }
    if (action.type === 'hover') {
      el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, composed: true }));
      return { ok: true };
    }
    if (action.type === 'type') {
      el.focus();
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
      setter ? setter.call(el, action.value || '') : el.value = action.value || '';
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: action.value || '' }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      if (action.submit) {
        // A semantic GET search must not depend on fragile page JavaScript. Build
        // a same-origin URL from only the observed search field; hidden form
        // values (tokens, session IDs, account data) deliberately stay local.
        const form = el.form;
        if (form && (form.method || 'get').toLowerCase() === 'get' && el.name) {
          try {
            const destination = new URL(form.action || location.href, location.href);
            if (destination.origin === location.origin) {
              destination.search = '';
              destination.searchParams.set(el.name, action.value || '');
              return { ok: true, navigateUrl: destination.href, expectedSearchValue: action.value || '' };
            }
          } catch {}
        }
        setTimeout(() => form?.requestSubmit?.(), 80);
      }
      return { ok: true, navigated: !!action.submit };
    }
    return { ok: false, error: 'Unsupported action' };
  }

  function onMessage(message, _sender, respond) {
    if (message?.type === 'LOCAL_FIELD_PREVIEW_UNAVAILABLE') {
      previewUnavailable(); respond({ ok: true }); return false;
    }
    if (message?.type === 'LOCAL_FIELD_SNAPSHOT') {
      try { respond(localFieldSnapshot()); }
      catch { respond({ error: 'Local field scan unavailable.' }); }
      return false;
    }
    if (message?.type === 'CAPTURE_PANEL') {
      // The panel is CAPTAIN-owned UI, not webpage content. Temporarily hide
      // it only while the trusted extension captures the working tab, so its
      // status glyphs do not poison page OCR. Page identity, masks and pixels
      // remain protected by the ordinary capture/lease/worker gates.
      const host = document.getElementById('captain-agent-host');
      if (!realExtension || !runtimeAlive() || message.mode === 'hide' &&
          (!privacyReady || privacyBlocked) || host?.dataset?.captainBuild !== '0.5.0') {
        respond({ ok: false }); return false;
      }
      if (message.mode === 'hide') {
        if (capturePanelState || !host.isConnected) { respond({ ok: false }); return false; }
        capturePanelState = { host, display: host.style.display, focused: host.shadowRoot?.activeElement };
        host.style.display = 'none';
        respond({ ok: host.style.display === 'none' }); return false;
      }
      if (message.mode === 'restore') {
        if (!capturePanelState) { respond({ ok: true }); return false; }
        if (capturePanelState.host !== host || !host.isConnected) {
          respond({ ok: false }); return false;
        }
        host.style.display = capturePanelState.display;
        const focused = capturePanelState.focused;
        capturePanelState = null;
        if (focused?.isConnected && (!document.activeElement || document.activeElement === document.body || document.activeElement === document.documentElement || document.activeElement === host))
          focused.focus?.({ preventScroll: true });
        respond({ ok: true }); return false;
      }
      respond({ ok: false }); return false;
    }
    // Local field-only PNG, never an outgoing image authorization/proof.
    if (message?.type === 'SHOW_LOCAL_FIELD_PREVIEW') {
      const screenshot = message.screenshot;
      const validImage = typeof screenshot === 'string' && screenshot.length >= 100 &&
        screenshot.length <= 3_400_000 &&
        /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(screenshot);
      const validCounts = Number.isSafeInteger(message.redactionBoxes) && message.redactionBoxes >= 0 && message.redactionBoxes <= 500 &&
        Number.isSafeInteger(message.faces) && message.faces >= 0 && message.faces <= 30;
      const validPrivacyMode = message.fullBlackout === false && message.localOnly === true;
      const shown = validImage && validCounts && validPrivacyMode && message.rawScreenshotTransmitted === false &&
        setPrivacyPreview(screenshot, { ...message, localOnly: true });
      respond({ ok: shown === true }); return false;
    }
    if (message?.type === 'SHOW_SENSITIVE_REDACTION_NOTICE') {
      const boxes = message.boxes;
      const validBoxes = Array.isArray(boxes) && boxes.length <= 500 && boxes.every(box => box &&
        ['x', 'y', 'width', 'height'].every(key => Number.isFinite(box[key]) && Math.abs(box[key]) <= 16384) &&
        box.width > 0 && box.height > 0 && typeof box.kind === 'string' && /^[A-Z][A-Z0-9_]{0,39}$/.test(box.kind));
      respond({ ok: validBoxes && setPrivacyNotice(boxes) === true }); return false;
    }
    if (realExtension && !privacyReady) {
      respond(message?.type === 'OBSERVE' || message?.type === 'READINESS' || message?.type === 'VISUAL_STABILITY' ?
        { error: 'Local privacy engine unavailable; observation blocked.' } :
        { ok: false, error: 'Local privacy engine unavailable; action blocked.' });
      return false;
    }
    if (realExtension && privacyBlocked) {
      respond(message?.type === 'OBSERVE' || message?.type === 'READINESS' || message?.type === 'VISUAL_STABILITY' ?
        { error: PRIVATE_OBSERVATION_ERROR } : { ok: false, error: PRIVATE_OBSERVATION_ERROR });
      return false;
    }
    if (message.type === 'OBSERVE') {
      observe(message.captureRequested === true).then(result => respond(realExtension && privacyBlocked ? { error: PRIVATE_OBSERVATION_ERROR } : result),
        error => respond({ error: realExtension ? PRIVATE_OBSERVATION_ERROR : error.message || String(error) }));
      return true;
    }
    if (message.type === 'READINESS') {
      try { respond(readiness()); }
      catch { respond({ error: 'Local readiness check failed.' }); }
      return false;
    }
    if (message.type === 'VISUAL_STABILITY') {
      visualStability().then(result => respond(realExtension && privacyBlocked ? { error: PRIVATE_OBSERVATION_ERROR } : result),
        () => {
          const allowed = new Set(['idle', 'readiness', 'text-masks', 'visual-masks', 'controls', 'control-links',
            'control-context', 'page-text', 'text-regions', 'visual-regions', 'lease', 'complete']);
          const status = globalThis.__captainPageController?.scanStatus?.() || {};
          // A fixed local stage label is useful for pacing diagnostics; it is
          // not displayed to the webpage, planner or user and never includes
          // page text, a selector, a value or a rectangle.
          respond({ error: realExtension ? PRIVATE_OBSERVATION_ERROR : 'Local visual stability check failed.',
            visualStage: status.privacyBlocked ? 'privacy-blocked' : allowed.has(status.stage) ? status.stage : 'unknown' });
        });
      return true;
    }
    if (message.type === 'EXECUTE') {
      if (realExtension && ['click','hover','type','press','select','submit','request_local_input'].includes(message.action?.type)) {
        flushMutations();
        const guard = message.observationGuard;
        if (!guard || !lastObservationId || guard.documentToken !== documentToken ||
          guard.domRevision !== domRevision || guard.geometryRevision !== geometryRevision ||
          guard.observationId !== lastObservationId || !/^c[1-9]\d*$/.test(message.action?.target?.ref || '') ||
          !target(message.action.target)) {
          respond({ ok: false, error: 'Observation expired or target changed; action blocked.' });
          return false;
        }
        // The observation lease is one-use, even when the website action fails.
        lastObservationId = '';
      }
      execute(message.action).then(respond).catch(error => respond({ ok: false, error: realExtension ? 'Local action failed.' : error.message })); return true;
    }
  }
  chrome.runtime.onMessage.addListener(onMessage);

  function mountCaptain() {
    if (document.querySelector('#captain-agent-host') || !document.documentElement) return;
    const host = document.createElement('div'); host.id = 'captain-agent-host';
    host.dataset.captainBuild = '0.5.0';
    host.style.cssText = 'all:initial;position:fixed;right:18px;bottom:18px;z-index:2147483647;display:none;color-scheme:dark';
    host.style.display = 'none';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>
      :host{font:13px system-ui,sans-serif}*{box-sizing:border-box}button,input{font:inherit}button{cursor:pointer}button:disabled{cursor:default;opacity:.5}[hidden]{display:none!important}
      /* The agent is always a compact, movable overlay.  Execution must never
         turn it into a page-sized layer: page content stays visible behind it. */
      .card{width:min(366px,calc(100vw - 16px));max-width:366px;max-height:min(640px,calc(100vh - 16px));overflow:auto;overscroll-behavior:contain;contain:layout paint style;color:#f4f4f5;background:#0c0b0e;border:1px solid #543137;border-radius:18px;box-shadow:0 20px 70px #0009;font:13px system-ui,sans-serif}
      .head{display:flex;align-items:center;gap:10px;padding:11px 13px;border-bottom:1px solid #302329;cursor:grab;touch-action:none;user-select:none}.head.dragging{cursor:grabbing}
      .logo{display:grid;place-items:center;flex-shrink:0;width:30px;height:30px;border:1px solid #ff4c61;border-radius:50%;color:#ff6779;font-weight:900;box-shadow:0 0 15px #f4354930}.head b{letter-spacing:.12em;font-size:13px}.drag-hint{font-size:10px;color:#a19097;line-height:1.5}.tools{margin-left:auto;display:flex;gap:3px}
      .tools button{background:transparent;color:#bdaab1;border:0;border-radius:6px;width:28px;height:30px;font-size:18px}.tools button:hover{background:#38242b}button:focus-visible,input:focus-visible,.head:focus-visible{outline:2px solid #ff6477;outline-offset:2px}
      .body{padding:12px}.row{display:flex;gap:6px}.task{min-width:0;flex:1;padding:10px;border:1px solid #494044;border-radius:9px;background:#1b181b;color:#fff}.go{border:0;border-radius:9px;padding:0 11px;font-weight:700}.go{background:#ff4c61;color:#fff}
      .status{display:flex;gap:8px;align-items:flex-start;margin-top:10px;padding:9px 10px;border-radius:8px;background:#1b161a;color:#d7d0d4;line-height:1.4;max-height:54px;overflow:auto}.dot{flex-shrink:0;width:7px;height:7px;margin-top:5px;border-radius:50%;background:#34d399;box-shadow:0 0 10px #34d399}.card.stale .dot{background:#fbbf24;box-shadow:none}
      .meta{display:flex;justify-content:space-between;margin-top:9px;color:#9e8e96;font-size:10px}.recovery{font-size:11px;color:#ffd4a4;line-height:1.5;margin-top:9px}.reload{background:#392821;color:#ffdda9;border:1px solid #715039;border-radius:6px;padding:5px 9px;margin-top:5px}.handoff{width:100%;margin-top:8px;padding:9px;border:1px solid #ff5368;border-radius:8px;background:#a81429;color:#fff;font-weight:800}
      .privacy-notice{margin-top:10px;padding:9px;border:1px solid #b86f25;border-radius:9px;background:#291a0c}.notice-head{display:flex;gap:8px;align-items:center;color:#fed7aa;font-size:11px;font-weight:800}.notice-close,.preview-close{margin-left:auto;border:0;border-radius:5px;background:#17443c;color:#d1fae5;padding:2px 7px;font-size:11px}.notice-close{background:#5e3413;color:#ffedd5}.notice-note{margin:5px 0;color:#fed7aa;font-size:10px;line-height:1.35}.notice-kinds{display:grid;grid-template-columns:1fr;margin-top:6px;padding:6px 8px;border-left:2px solid #f59e0b;color:#fde68a;font-size:10px;line-height:1.55;white-space:pre-line}.privacy-consent{margin-top:10px;padding:10px;border:1px solid #f59e0b;border-radius:9px;background:#35200b}.consent-head{color:#fef3c7;font-size:11px;font-weight:800}.consent-note{margin:5px 0 8px;color:#fed7aa;font-size:10px;line-height:1.4}.consent-actions{display:flex;gap:7px}.consent-continue,.consent-stop{border:0;border-radius:7px;padding:7px 8px;font-size:10px;font-weight:800}.consent-continue{background:#16a34a;color:#f0fdf4}.consent-stop{background:#5e3413;color:#ffedd5}.privacy-markers{position:fixed;inset:0;z-index:2147483646;pointer-events:none}.privacy-marker{position:fixed;border:2px solid #eab308;background:rgba(250,204,21,.22);box-shadow:0 0 0 1px #1118}.privacy-preview{margin-top:10px;padding:9px;border:1px solid #2f6258;border-radius:9px;background:#0d201d}.preview-head{display:flex;gap:8px;align-items:center;color:#bbf7d0;font-size:11px;font-weight:800}.preview-note{margin:5px 0 7px;color:#a7c8bf;font-size:10px;line-height:1.35}.preview-stage{position:relative;display:grid;place-items:center;width:100%;height:138px;overflow:hidden;border-radius:5px;background:#09090b}.preview-canvas{display:block;width:100%;height:100%;object-fit:contain}.preview-placeholder{position:absolute;inset:0;display:grid;place-content:center;gap:7px;padding:18px;text-align:center;background:radial-gradient(circle at 50% 28%,#183b3533,#09090b 62%);color:#d1fae5}.preview-placeholder strong{font-size:12px}.preview-placeholder span{max-width:240px;color:#a7c8bf;font-size:10px;line-height:1.45}.preview-placeholder.loading strong::before{content:'◌';display:inline-block;margin-right:7px;animation:captain-spin 1.1s linear infinite}.preview-placeholder.blackout{background:linear-gradient(135deg,#0b1514,#111215);border:1px solid #30534d}.preview-placeholder.blackout strong::before{content:'▣';margin-right:7px;color:#fbbf24}@keyframes captain-spin{to{transform:rotate(1turn)}}
      .card.collapsed{width:228px}.card.collapsed .body{display:none}.card.collapsed .head{border-bottom:0}
    </style><div class="privacy-markers" aria-hidden="true"></div><section class="card" aria-label="CAPTAIN browser controls">
      <header class="head" tabindex="0" title="Drag to move. Arrow keys move; Home resets position." aria-label="Move CAPTAIN panel. Use arrow keys or drag."><span class="logo">C</span><div><b>CAPTAIN</b><div class="drag-hint">Drag to move · 0.5.0</div></div><div class="tools"><button class="reset" title="Reset position" aria-label="Reset panel position">⌖</button><button class="collapse" title="Minimize panel" aria-label="Minimize panel" aria-expanded="true">−</button></div></header>
      <div class="body"><div class="row"><input class="task" aria-label="Browser command" placeholder="Type a command…"><button class="go">RUN</button></div>
      <div class="status" role="status" aria-live="polite"><i class="dot"></i><span class="phase">Ready — type a command</span></div>
      <button class="handoff" hidden>Resume CAPTAIN</button>
      <section class="privacy-notice" hidden aria-live="polite"><div class="notice-head"><span>Sensitive data detected</span><button class="notice-close" type="button" aria-label="Hide sensitive-data markers">Hide</button></div><p class="notice-note">Yellow areas stay visible on this page. Their screenshot copies are blacked out.</p><div class="notice-kinds"></div></section>
      <section class="privacy-consent" hidden aria-live="assertive"><div class="consent-head">Permission required</div><p class="consent-note">Sensitive data is marked on the page and listed above as withheld. Continue without sharing it?</p><div class="consent-actions"><button class="consent-continue" type="button">Continue without sharing</button><button class="consent-stop" type="button">Stop</button></div></section>
      <section class="privacy-preview" hidden aria-live="polite"><div class="preview-head"><span>Local field screenshot</span><button class="preview-close" type="button" aria-label="Close sanitized preview">Close</button></div><p class="preview-note">Local masking only. Raw screenshot not transmitted.</p><div class="preview-stage"><canvas class="preview-canvas" aria-label="Local screenshot with sensitive fields blacked out" hidden></canvas><div class="preview-placeholder loading"><strong>Preparing protected screenshot</strong><span>Capturing and masking locally.</span></div></div></section>
      <div class="recovery" hidden>Reconnect CAPTAIN, then retry.<br><button class="reload">Reload page</button></div>
      <div class="meta"><span class="pii">0 PII matches</span><span class="steps">0 steps</span><span>Preview is local only</span></div></div>
    </section>`;
    document.documentElement.appendChild(host);
    const input = root.querySelector('.task'), phase = root.querySelector('.phase'), card = root.querySelector('.card'), head = root.querySelector('.head');
    const go = root.querySelector('.go'), collapse = root.querySelector('.collapse'), handoff = root.querySelector('.handoff');
    const preview = root.querySelector('.privacy-preview'), previewCanvas = root.querySelector('.preview-canvas'), previewNote = root.querySelector('.preview-note'), previewPlaceholder = root.querySelector('.preview-placeholder');
    const privacyNotice = root.querySelector('.privacy-notice'), privacyKinds = root.querySelector('.notice-kinds'), privacyMarkers = root.querySelector('.privacy-markers');
    const privacyConsent = root.querySelector('.privacy-consent'), consentContinue = root.querySelector('.consent-continue'), consentStop = root.querySelector('.consent-stop');
    let pollTimer, pending = false, stale = false, userMoved = false, drag, previewGeneration = 0, localCapturePending = false, localFieldCount = null;
    const layoutKey = 'captainPanelLayout';
    let layout = { x: 0, y: 0, collapsed: false };
    function bounds() {
      const box = host.getBoundingClientRect();
      return { maxX: Math.max(8, innerWidth - box.width - 8), maxY: Math.max(8, innerHeight - box.height - 8) };
    }
    function move(x, y, remember = true) {
      const { maxX, maxY } = bounds();
      const left = Math.max(8, Math.min(maxX, x)), top = Math.max(8, Math.min(maxY, y));
      host.style.left = `${left}px`; host.style.top = `${top}px`; host.style.right = 'auto'; host.style.bottom = 'auto';
      layout.x = maxX > 8 ? (left - 8) / (maxX - 8) : 0;
      layout.y = maxY > 8 ? (top - 8) / (maxY - 8) : 0;
      if (remember) { layout.left = left; layout.top = top; }
    }
    function place() {
      card.classList.toggle('collapsed', layout.collapsed);
      collapse.textContent = layout.collapsed ? '+' : '−';
      collapse.title = layout.collapsed ? 'Expand panel' : 'Minimize panel';
      collapse.setAttribute('aria-label', collapse.title);
      collapse.setAttribute('aria-expanded', String(!layout.collapsed));
      const { maxX, maxY } = bounds();
      // A preview changes panel height. Preserve a user's pixel position
      // instead of applying the old height's percentage to the new height.
      move(Number.isFinite(layout.left) ? layout.left : 8 + layout.x * (maxX - 8),
        Number.isFinite(layout.top) ? layout.top : 8 + layout.y * (maxY - 8), false);
    }
    async function persist() {
      userMoved = true;
      // Only geometry is saved: never commands, page contents or transcripts.
      try { if (runtimeAlive()) await chrome.storage.local.set({ [layoutKey]: { ...layout } }); } catch {}
    }
    head.addEventListener('pointerdown', event => {
      if (event.button !== 0 || event.target.closest('button')) return;
      const box = host.getBoundingClientRect();
      drag = { id: event.pointerId, dx: event.clientX - box.left, dy: event.clientY - box.top };
      userMoved = true; head.setPointerCapture(event.pointerId); head.classList.add('dragging'); event.preventDefault();
    });
    head.addEventListener('pointermove', event => {
      if (drag?.id !== event.pointerId) return;
      move(event.clientX - drag.dx, event.clientY - drag.dy);
    });
    function endDrag(event) {
      if (drag?.id !== event.pointerId) return;
      drag = null; head.classList.remove('dragging');
      if (head.hasPointerCapture(event.pointerId)) head.releasePointerCapture(event.pointerId);
      persist();
    }
    for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) head.addEventListener(name, endDrag);
    function reset() { layout = { x: 0, y: 0, collapsed: layout.collapsed }; place(); persist(); }
    head.addEventListener('keydown', event => {
      if (event.target !== head) return;
      if (event.key === 'Home') { event.preventDefault(); reset(); return; }
      const delta = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
      if (!delta) return;
      event.preventDefault(); const box = host.getBoundingClientRect(), step = event.shiftKey ? 40 : 10;
      move(box.left + delta[0] * step, box.top + delta[1] * step); persist();
    });
    root.querySelector('.reset').onclick = reset;
    collapse.onclick = () => { layout.collapsed = !layout.collapsed; place(); persist(); };
    addEventListener('resize', place);
    place();
    chrome.storage.local.get(layoutKey).then(saved => {
      const value = saved[layoutKey];
      if (!userMoved && connected && value && Number.isFinite(value.x) && Number.isFinite(value.y)) {
        layout = { x: Math.min(1, Math.max(0, value.x)), y: Math.min(1, Math.max(0, value.y)), collapsed: value.collapsed === true,
          ...(Number.isFinite(value.left) && Number.isFinite(value.top) ? { left: value.left, top: value.top } : {}) }; place();
      }
    }).catch(() => {});
    const layoutObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(() => {
      if (connected && host.isConnected && !capturePanelState && !drag) place();
    }) : null;
    layoutObserver?.observe(card);
    const SENSITIVE_ACCESS_REQUIRED_MESSAGE = 'the site does not allow entry without information access please tell me what to do further ?';
    function phaseForState(current) {
      if (current?.phase === 'SENSITIVE_ACCESS_REQUIRED' || current?.message === SENSITIVE_ACCESS_REQUIRED_MESSAGE) {
        // This is the sole explanatory outcome required by the interaction
        // contract. Do not replace it with planner prose.
        return SENSITIVE_ACCESS_REQUIRED_MESSAGE;
      }
      if (current?.status === 'waiting_privacy_consent') return 'Sensitive fields marked — permission required.';
      if (current?.status === 'waiting_human') return 'Verification required.';
      if (current?.status === 'running') {
        return ({ OBSERVING: 'Scanning page…', PROTECTING_PRIVACY: 'Masking sensitive fields…', EXECUTING: 'Executing…',
          VERIFYING: 'Checking page…', RESUMING: 'Scanning page…', RECOVERING: 'Scanning page…', PRIVACY_CONFIRMATION_REQUIRED: 'Sensitive fields marked…' }[current.phase] || 'Executing…');
      }
      if (current?.status === 'complete' || current?.status === 'idle') return 'Ready — type a command';
      if (current?.status === 'error') {
        if (current?.phase === 'Cancelled') return 'Cancelled.';
        if (current?.visualStage) return 'Screenshot withheld. Page changed or capture failed. Try again.';
        return 'Command stopped. Try again.';
      }
      return 'Ready — type a command';
    }
    function disconnected() {
      stale = true; clearInterval(pollTimer); go.disabled = true; card.classList.add('stale');
      phase.textContent = 'Connection lost — reopen CAPTAIN.';
      root.querySelector('.recovery').hidden = false;
    }
    async function message(payload) {
      if (!runtimeAlive()) { disconnected(); throw new Error('CAPTAIN is disconnected.'); }
      try { return await chrome.runtime.sendMessage(payload); }
      catch (error) {
        if (!runtimeAlive() || /extension context invalidated|receiving end does not exist|could not establish connection/i.test(error.message)) disconnected();
        throw error;
      }
    }
    root.querySelector('.reload').onclick = () => location.reload();
    const categoryLabel = kind => ({ EMAIL: 'Email address', PHONE: 'Phone number', CARD: 'Payment card', AADHAAR: 'Aadhaar number', PAN: 'PAN', ADDRESS: 'Address', PERSON: 'Name', CREDENTIAL: 'Sign-in field', DATE_OF_BIRTH: 'Date of birth', DOB: 'Date of birth', PASSWORD: 'Password', OTP: 'One-time password', CVV: 'CVV', PIN: 'PIN', TOKEN: 'Access token', SECRET: 'Sensitive field', UNKNOWN: 'Uncertain sensitive content' }[kind] || kind.replaceAll('_', ' ').toLowerCase().replace(/^./, char => char.toUpperCase()));
    function clearPrivacyNotice() {
      privacyMarkers.replaceChildren?.();
      privacyNotice.hidden = true;
    }
    setPrivacyNotice = boxes => {
      if (!runtimeAlive() || !host.isConnected || capturePanelState) return false;
      showPanel(false);
      clearPrivacyNotice();
      const visible = boxes.filter(box => !['RASTER_CONTENT', 'BACKGROUND_IMAGE', 'UNKNOWN'].includes(box.kind) && box.x < innerWidth && box.y < innerHeight && box.x + box.width > 0 && box.y + box.height > 0).slice(0, 500);
      localFieldCount = visible.length;
      root.querySelector('.pii').textContent = `${localFieldCount} sensitive regions`;
      const kinds = [...new Set(visible.map(box => categoryLabel(box.kind)))];
      for (const box of visible) {
        const marker = document.createElement('div');
        marker.className = 'privacy-marker';
        marker.style.cssText = `left:${Math.max(0, box.x)}px;top:${Math.max(0, box.y)}px;width:${Math.min(innerWidth, box.width)}px;height:${Math.min(innerHeight, box.height)}px;`;
        privacyMarkers.appendChild(marker);
      }
      privacyKinds.textContent = kinds.length ? `WITHHELD LOCALLY\n${kinds.join('\n')}` : 'No sensitive fields detected in this view.';
      privacyNotice.hidden = false;
      return true;
    };
    root.querySelector('.notice-close').onclick = clearPrivacyNotice;
    function clearPreviewCanvas() {
      previewGeneration++;
      const context = previewCanvas.getContext?.('2d');
      context?.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
      previewCanvas.width = 0; previewCanvas.height = 0; previewCanvas.hidden = true;
    }
    function showPreviewFallback() {
      clearPreviewCanvas();
      previewPlaceholder.hidden = false;
      previewPlaceholder.className = 'preview-placeholder blackout';
      previewPlaceholder.innerHTML = '<strong>Protected preview unavailable</strong><span>No raw page pixels were transmitted.</span>';
      previewNote.textContent = 'Local privacy protection remains active.';
    }
    previewUnavailable = showPreviewFallback;
    function showPreviewActivity(message = 'Capturing and masking locally.') {
      preview.hidden = false;
      clearPreviewCanvas();
      previewPlaceholder.hidden = false;
      previewPlaceholder.className = 'preview-placeholder loading';
      previewPlaceholder.innerHTML = `<strong>Preparing protected screenshot</strong><span>${message}</span>`;
      previewNote.textContent = 'Local masking only. Raw screenshot not transmitted.';
    }
    function clearPrivacyPreview() {
      clearPreviewCanvas();
      previewPlaceholder.hidden = false;
      previewPlaceholder.className = 'preview-placeholder loading';
      previewPlaceholder.innerHTML = '<strong>Preparing protected screenshot</strong><span>Capturing and masking locally.</span>';
      preview.hidden = true;
    }
    setPrivacyPreview = (screenshot, details) => {
      if (!runtimeAlive() || !host.isConnected || capturePanelState) return false;
      if (details.fullBlackout !== false || details.localOnly !== true) return false;
      {
        clearPreviewCanvas();
        const renderGeneration = previewGeneration;
        previewPlaceholder.hidden = false;
        previewPlaceholder.className = 'preview-placeholder loading';
        previewPlaceholder.innerHTML = '<strong>Rendering protected screenshot</strong><span>Drawing the masked frame locally.</span>';
        previewNote.textContent = `${details.redactionBoxes} sensitive region${details.redactionBoxes === 1 ? '' : 's'} blacked out · local only, not sent.`;
        (async () => {
          try {
            const response = await fetch(screenshot);
            const blob = await response.blob();
            if (!response.ok || blob.type !== 'image/png' || !globalThis.createImageBitmap) throw new Error('Sanitized image decode unavailable.');
            const bitmap = await createImageBitmap(blob);
            try {
              if (!host.isConnected || preview.hidden || renderGeneration !== previewGeneration) return;
              const context = previewCanvas.getContext('2d', { alpha: false });
              if (!context || bitmap.width < 1 || bitmap.height < 1) throw new Error('Sanitized canvas unavailable.');
              previewCanvas.width = bitmap.width; previewCanvas.height = bitmap.height;
              context.drawImage(bitmap, 0, 0);
              previewCanvas.hidden = false;
              previewPlaceholder.hidden = true;
            } finally { bitmap.close?.(); }
          } catch { if (renderGeneration === previewGeneration) showPreviewFallback(); }
        })();
      }
      preview.hidden = false;
      return true;
    };
    root.querySelector('.preview-close').onclick = clearPrivacyPreview;
    consentContinue.onclick = async () => {
      consentContinue.disabled = consentStop.disabled = true;
      try { const result = await message({ type: 'PRIVACY_CONTINUE' }); phase.textContent = result.ok ? 'Executing…' : 'Unavailable.'; }
      catch { if (!stale) phase.textContent = 'Unavailable.'; }
      finally { consentContinue.disabled = consentStop.disabled = false; }
    };
    consentStop.onclick = async () => {
      consentContinue.disabled = consentStop.disabled = true;
      try { const result = await message({ type: 'PRIVACY_STOP' }); phase.textContent = result.ok ? 'Ready — type a command' : 'Unavailable.'; }
      catch { if (!stale) phase.textContent = 'Unavailable.'; }
      finally { consentContinue.disabled = consentStop.disabled = false; }
    };
    go.onclick = async () => {
      const task = input.value.trim(); if (!task) return input.focus();
      if (pending || stale || localCapturePending) return;
      pending = true; go.disabled = true;
      phase.textContent = 'Executing…';
      showPreviewActivity();
      try {
        const result = await message({ type: 'START_TASK', task });
        if (!result.ok) phase.textContent = 'Command unavailable.';
      } catch { if (!stale) phase.textContent = 'Command unavailable.'; }
      finally { pending = false; if (!stale) go.disabled = false; }
    };
    input.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.isComposing && !go.disabled) { event.preventDefault(); go.onclick(); } });
    handoff.onclick = async () => {
      handoff.disabled = true; phase.textContent = 'Checking verification…';
      try { const result = await message({ type: 'RESUME_TASK' }); phase.textContent = result.ok ? 'Scanning page…' : 'Verification pending.'; }
      catch { if (!stale) phase.textContent = 'Verification pending.'; }
      finally { handoff.disabled = false; }
    };
    let polling = false;
    async function refreshPanel() {
      if (polling || stale || !connected) return;
      polling = true;
      try {
        const s = await message({ type: 'GET_STATE' });
        if (!connected || stale) return;
        const executionActive = ['running', 'waiting_human', 'waiting_privacy_consent'].includes(s.status);
        if (!pending && !localCapturePending) phase.textContent = phaseForState(s);
        if (executionActive && host.style.display === 'none' && !capturePanelState) showPanel(false);
        const waitingPrivacy = s.status === 'waiting_privacy_consent';
        if (executionActive && preview.hidden) showPreviewActivity(s.phase === 'OBSERVING' ? 'Scanning page locally.' : 'Masking sensitive fields locally.');
        privacyConsent.hidden = !waitingPrivacy;
        handoff.hidden = s.status !== 'waiting_human';
        go.disabled = localCapturePending || pending || ['running', 'waiting_human', 'waiting_privacy_consent'].includes(s.status);
        root.querySelector('.pii').textContent = `${localFieldCount ?? s.piiDetected ?? 0} sensitive regions`;
        root.querySelector('.steps').textContent = `${s.step || 0} steps`;
      } catch { if (!stale) phase.textContent = 'Connection unavailable.'; }
      finally { polling = false; }
    }
    let holdTimer = null;
    function cancelHold() { clearTimeout(holdTimer); holdTimer = null; }
    function showPanel(resetPosition = true) {
      if (!connected || capturePanelState) return;
      host.style.display = 'block';
      if (resetPosition) {
        userMoved = true;
        layout = { x: 0, y: 0, collapsed: false };
      }
      place();
      if (resetPosition) { input.focus(); void refreshPanel(); }
    }
    async function captureCurrentPage() {
      if (localCapturePending || pending || stale) return;
      let taskBusy = false;
      localCapturePending = true; go.disabled = true;
      phase.textContent = 'Scanning sensitive fields…';
      clearPrivacyNotice();
      showPreviewActivity('Taking a local screenshot…');
      try {
        const result = await message({ type: 'CAPTURE_LOCAL_PREVIEW' });
        if (!result.ok) {
          taskBusy = !!result.busy;
          if (!result.busy) showPreviewFallback();
          phase.textContent = result.busy ? 'Task in progress.' : 'Capture unavailable — hold E to retry.';
        } else phase.textContent = 'Local screenshot ready — type a command';
      } catch { if (!stale) { showPreviewFallback(); phase.textContent = 'Capture unavailable — hold E to retry.'; } }
      finally { localCapturePending = false; if (!stale) { go.disabled = taskBusy; if (taskBusy) void refreshPanel(); } }
    }
    function holdKey(event) {
      if (event.isTrusted !== true || event.repeat || event.isComposing ||
          event.ctrlKey || event.altKey || event.metaKey || event.shiftKey ||
          String(event.key).toLowerCase() !== 'e') return;
      const path = event.composedPath?.() || [event.target];
      if (path.some(node => node?.isContentEditable ||
          /^(INPUT|TEXTAREA|SELECT)$/.test(node?.tagName || '') ||
          node?.getAttribute?.('role') === 'textbox')) return;
      cancelHold();
      holdTimer = setTimeout(() => {
        holdTimer = null; showPanel(); void captureCurrentPage();
      }, 4000);
    }
    function releaseKey(event) { if (String(event.key).toLowerCase() === 'e') cancelHold(); }
    function visibilityChanged() { cancelHold(); if (!document.hidden && host.style.display !== 'none') void refreshPanel(); }
    function stateChanged(changes, area) {
      if (area === 'local' && changes.captainState) void refreshPanel();
    }
    addEventListener('keydown', holdKey, true);
    addEventListener('keyup', releaseKey, true);
    addEventListener('blur', cancelHold);
    document.addEventListener('visibilitychange', visibilityChanged);
    chrome.storage.onChanged?.addListener(stateChanged);
    pollTimer = setInterval(() => {
      if (!document.hidden && host.style.display !== 'none') void refreshPanel();
    }, 3000);
    refreshPanel();
    disposePanel = () => {
      cancelHold();
      removeEventListener('keydown', holdKey, true);
      removeEventListener('keyup', releaseKey, true);
      removeEventListener('blur', cancelHold);
      document.removeEventListener('visibilitychange', visibilityChanged);
      chrome.storage.onChanged?.removeListener(stateChanged);
      clearInterval(pollTimer); layoutObserver?.disconnect(); clearPrivacyNotice(); clearPrivacyPreview(); setPrivacyPreview = setPrivacyNotice = () => false; removeEventListener('resize', place); host.remove(); };
  }
  mountCaptain();
})();
