/*
 * CAPTAIN Phase-05 local OCR geometry and privacy decisions.
 * Classic script shared by browser workers and source-only VM fixtures.
 * OCR strings and UTF-16 offsets exist only inside review()/planMasks().
 * Public results contain mask geometry alone, never text, words or cN refs.
 */
(() => {
  'use strict';

  const ERROR = 'Local OCR geometry unavailable.';
  const MAX_WORDS = 600;
  const MAX_LINE_LENGTH = 16_384;
  // Tesseract word confidence is in [0, 100].  A score of 40 still requires
  // the deterministic local PII scan; below it, geometry is opaque.  The old
  // 80 cutoff classified ordinary, clearly rendered page copy as unknown and
  // obscured it even after the browser had captured it correctly.
  const MIN_CONFIDENCE = 40;
  const PII_TYPES = new Set([
    'EMAIL', 'PHONE', 'PAN', 'AADHAAR', 'CARD', 'API_KEY', 'TOKEN',
    'PASSWORD', 'OTP', 'PIN', 'CREDENTIAL', 'PERSON', 'ADDRESS', 'ACCOUNT',
    // The deterministic scanner explicitly marks opaque identifiers as UNKNOWN.
    // Their exact OCR-word geometry can be masked safely; treating that valid
    // privacy finding as a whole-frame parser failure made useful previews
    // needlessly unavailable.
    'UNKNOWN'
  ]);
  const FULL = () => ({ fullBlackout: true, regions: [] });
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const positive = value => finite(value) && value > 0 && value <= 100_000;
  const dimensions = (width, height) => Number.isSafeInteger(width) &&
    Number.isSafeInteger(height) && positive(width) && positive(height) &&
    width * height <= 12_000_000;
  const clip = (value, low, high) => Math.min(high, Math.max(low, value));

  function rect(box, width, height) {
    if (!box || ![box.x0, box.y0, box.x1, box.y1].every(finite) ||
        box.x0 < 0 || box.y0 < 0 || box.x1 > width || box.y1 > height ||
        box.x1 <= box.x0 || box.y1 <= box.y0) throw new Error(ERROR);
    return { x1: box.x0, y1: box.y0, x2: box.x1, y2: box.y1 };
  }

  function maskUnion(regions) {
    const merged = [];
    for (const region of regions) {
      let current = { ...region, kind: 'PII' };
      for (let i = 0; i < merged.length;) {
        const prior = merged[i];
        // Merge nested and overlapping rectangles, but keep separate words on
        // separate lines distinct when they are spatially disjoint.
        if (current.x1 < prior.x2 && current.x2 > prior.x1 &&
            current.y1 < prior.y2 && current.y2 > prior.y1) {
          current = {
            x1: Math.min(current.x1, prior.x1), y1: Math.min(current.y1, prior.y1),
            x2: Math.max(current.x2, prior.x2), y2: Math.max(current.y2, prior.y2),
            kind: 'PII'
          };
          merged.splice(i, 1);
          i = 0;
        } else i++;
      }
      merged.push(current);
    }
    if (merged.length > MAX_WORDS) throw new Error(ERROR);
    return merged;
  }

  function linesForWords(words) {
    const rows = [];
    for (const word of [...words].sort((a, b) =>
      (a.box.y1 + a.box.y2) - (b.box.y1 + b.box.y2) || a.box.x1 - b.box.x1)) {
      const cy = (word.box.y1 + word.box.y2) / 2;
      let row = rows.find(candidate => {
        const overlap = Math.min(word.box.y2, candidate.bottom) -
          Math.max(word.box.y1, candidate.top);
        return overlap >= Math.min(word.box.y2 - word.box.y1,
          candidate.bottom - candidate.top) * 0.45 &&
          Math.abs(cy - candidate.center) <=
          Math.max(word.box.y2 - word.box.y1, candidate.bottom - candidate.top) * 0.6;
      });
      if (!row) {
        row = { words: [], top: word.box.y1, bottom: word.box.y2, center: cy };
        rows.push(row);
      }
      row.words.push(word);
      row.top = Math.min(row.top, word.box.y1);
      row.bottom = Math.max(row.bottom, word.box.y2);
      row.center = (row.top + row.bottom) / 2;
    }
    for (const row of rows) row.words.sort((a, b) => a.box.x1 - b.box.x1 ||
      a.box.y1 - b.box.y1);
    return rows;
  }

  function scanLine(words, separator, scanSpans) {
    let value = '';
    const offsets = [];
    for (const word of words) {
      if (offsets.length) value += separator;
      if (value.length + word.text.length > MAX_LINE_LENGTH) throw new Error(ERROR);
      const start = value.length;
      value += word.text;
      offsets.push({ start, end: value.length, box: word.box });
    }
    const spans = scanSpans(value);
    if (!Array.isArray(spans) || spans.length > 256) throw new Error(ERROR);
    const regions = [];
    for (const span of spans) {
      if (!span || !Number.isSafeInteger(span.start) || !Number.isSafeInteger(span.end) ||
          span.start < 0 || span.end > value.length || span.end <= span.start ||
          !PII_TYPES.has(span.type)) throw new Error(ERROR);
      const covered = offsets.filter(offset =>
        span.start < offset.end && span.end > offset.start);
      if (!covered.length) throw new Error(ERROR);
      regions.push({
        x1: Math.min(...covered.map(word => word.box.x1)),
        y1: Math.min(...covered.map(word => word.box.y1)),
        x2: Math.max(...covered.map(word => word.box.x2)),
        y2: Math.max(...covered.map(word => word.box.y2)),
        kind: 'PII'
      });
    }
    return regions;
  }

  function rowMask(words) {
    if (!Array.isArray(words) || !words.length) throw new Error(ERROR);
    return {
      x1: Math.min(...words.map(word => word.box.x1)),
      y1: Math.min(...words.map(word => word.box.y1)),
      x2: Math.max(...words.map(word => word.box.x2)),
      y2: Math.max(...words.map(word => word.box.y2)),
      kind: 'PII'
    };
  }

  // OCR can put independent page columns, a floating CAPTAIN panel and page
  // content into one geometric row.  Treating that entire row as one private
  // string made one uncertain token conceal unrelated public content.  A run
  // joins only immediately neighbouring OCR boxes: this still protects split
  // identifiers (for example `1234 5678` or `name @ host`) while an uncertain
  // word is never allowed to black out a distant column merely because it has
  // the same y-coordinate.  The threshold is deliberately small and bounded;
  // every uncertain word remains inside its own opaque run.
  function visualRuns(words) {
    if (!Array.isArray(words) || !words.length) throw new Error(ERROR);
    const runs = [];
    let current = [];
    for (const word of words) {
      const prior = current.at(-1);
      if (prior) {
        // OCR can emit a nested duplicate after the wider word it belongs to.
        // Compare a following word with the run's visible right edge, not the
        // last emitted duplicate, so normal adjacent private text does not
        // become a needlessly fragmented set of masks.
        const rightmost = current.reduce((edge, item) => item.box.x2 > edge.box.x2 ? item : edge, prior);
        const priorHeight = rightmost.box.y2 - rightmost.box.y1;
        const wordHeight = word.box.y2 - word.box.y1;
        const joinGap = Math.max(12, Math.min(32,
          Math.ceil(Math.max(priorHeight, wordHeight) * 0.75)));
        if (word.box.x1 - rightmost.box.x2 > joinGap) {
          runs.push(current);
          current = [];
        }
      }
      current.push(word);
    }
    if (current.length) runs.push(current);
    return runs;
  }

  // Local OCR is installed with an English model, but the captured page can
  // contain another script or a low-confidence token. Those pixels are not
  // evidence that a whole screenshot is private. We do not semantically parse
  // an uncertain visual run; instead, we mask its complete local run so no
  // uncertain word (or an adjacent split identifier) can leave the worker.
  const reliableAsciiWord = word => word.confidence >= MIN_CONFIDENCE &&
    /^[\x20-\x7e]+$/.test(word.text);

  function review(input) {
    try {
      const { words, width, height } = input || {};
      const scan = globalThis.CAPTAIN_PRIVACY?.scanSpans;
      if (!dimensions(width, height) || !Array.isArray(words) || !words.length ||
          words.length > MAX_WORDS || typeof scan !== 'function') return FULL();
      const validated = words.map(word => {
        if (!word || typeof word.text !== 'string' || !word.text.trim() ||
            word.text.length > 128 || !finite(word.confidence) ||
            word.confidence < 0 || word.confidence > 100) throw new Error(ERROR);
        return { text: word.text, confidence: word.confidence,
          box: rect(word.bbox, width, height) };
      });
      const masks = [];
      for (const row of linesForWords(validated)) {
        for (const run of visualRuns(row.words)) {
          if (run.some(word => !reliableAsciiWord(word))) {
            masks.push(rowMask(run));
            continue;
          }
          // Preserve spaces for labelled fields. Also scan compactly, since OCR
          // may split emails, IDs and other private strings across word boxes.
          masks.push(...scanLine(run, ' ', scan));
          if (run.length > 1) masks.push(...scanLine(run, '', scan));
        }
      }
      return { fullBlackout: false, regions: maskUnion(masks) };
    } catch {
      // Never expose OCR text, source objects or model exception messages.
      return FULL();
    }
  }

  function viewportScale(viewport, width, height) {
    if (!dimensions(width, height) || !viewport ||
        !positive(viewport.width) || !positive(viewport.height) ||
        !finite(viewport.devicePixelRatio) ||
        viewport.devicePixelRatio < 0.01 || viewport.devicePixelRatio > 100) {
      throw new Error(ERROR);
    }
    const scaleX = width / viewport.width, scaleY = height / viewport.height;
    const ratio = Math.max(scaleX, scaleY) / Math.min(scaleX, scaleY);
    const dprRatio = Math.max(scaleX, viewport.devicePixelRatio) /
      Math.min(scaleX, viewport.devicePixelRatio);
    if (!finite(ratio) || !finite(dprRatio) || ratio > 1.02 || dprRatio > 1.1 ||
        scaleX < 0.1 || scaleX > 100) throw new Error(ERROR);
    return { scaleX, scaleY };
  }

  function mapSurfaceBox({ bbox, surface, viewport, width, height }) {
    if (!surface || !['image', 'canvas', 'raster'].includes(surface.kind) ||
        surface.axisAligned !== true || !positive(surface.intrinsicWidth) ||
        !positive(surface.intrinsicHeight) || !surface.rect ||
        ![surface.rect.x, surface.rect.y, surface.rect.width, surface.rect.height].every(finite) ||
        surface.rect.width <= 0 || surface.rect.height <= 0 ||
        !['fill', 'contain', 'cover', 'none', 'scale-down'].includes(surface.objectFit) ||
        !finite(surface.objectPositionX) || !finite(surface.objectPositionY) ||
        surface.objectPositionX < 0 || surface.objectPositionX > 1 ||
        surface.objectPositionY < 0 || surface.objectPositionY > 1) throw new Error(ERROR);
    const bounds = rect(bbox, surface.intrinsicWidth, surface.intrinsicHeight);
    const css = surface.rect, intrinsicW = surface.intrinsicWidth, intrinsicH = surface.intrinsicHeight;
    const contain = Math.min(css.width / intrinsicW, css.height / intrinsicH);
    const cover = Math.max(css.width / intrinsicW, css.height / intrinsicH);
    const factor = surface.objectFit === 'contain' ? contain :
      surface.objectFit === 'cover' ? cover :
      surface.objectFit === 'scale-down' ? Math.min(1, contain) : 1;
    const displayedWidth = surface.objectFit === 'fill' ? css.width : intrinsicW * factor;
    const displayedHeight = surface.objectFit === 'fill' ? css.height : intrinsicH * factor;
    const xScale = displayedWidth / intrinsicW, yScale = displayedHeight / intrinsicH;
    const offsetX = css.x + (css.width - displayedWidth) * surface.objectPositionX;
    const offsetY = css.y + (css.height - displayedHeight) * surface.objectPositionY;
    const cssLeft = clip(offsetX + bounds.x1 * xScale, css.x, css.x + css.width);
    const cssTop = clip(offsetY + bounds.y1 * yScale, css.y, css.y + css.height);
    const cssRight = clip(offsetX + bounds.x2 * xScale, css.x, css.x + css.width);
    const cssBottom = clip(offsetY + bounds.y2 * yScale, css.y, css.y + css.height);
    const scale = viewportScale(viewport, width, height);
    const result = {
      x0: clip(cssLeft * scale.scaleX, 0, width),
      y0: clip(cssTop * scale.scaleY, 0, height),
      x1: clip(cssRight * scale.scaleX, 0, width),
      y1: clip(cssBottom * scale.scaleY, 0, height)
    };
    rect(result, width, height); // Cropped away/offscreen or invalid geometry fails closed.
    return result;
  }

  function planMasks(input) {
    try {
      if (!input || !Array.isArray(input.words) || !input.words.length ||
          input.words.length > MAX_WORDS) return FULL();
      if (input.space === undefined || input.space === 'screenshot') return review(input);
      if (!['image', 'canvas', 'raster'].includes(input.space)) return FULL();
      if (input.surface?.kind !== input.space) return FULL();
      const mapped = input.words.map(word => ({
        text: word?.text,
        confidence: word?.confidence,
        bbox: mapSurfaceBox({
          bbox: word?.bbox, surface: input.surface, viewport: input.viewport,
          width: input.width, height: input.height
        })
      }));
      return review({ words: mapped, width: input.width, height: input.height });
    } catch { return FULL(); }
  }

  globalThis.CaptainOCRGeometry = Object.freeze({ review, planMasks, mapSurfaceBox });
})();
