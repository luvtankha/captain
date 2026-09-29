// Every dependency is extension-local.  OCR text and the raw capture remain
// inside this worker; only opaque masks and the checked JPEG may leave it.
importScripts('vendor/ort.min.js', 'vision-core.js', 'privacy/privacy-core.js', 'text/ocr-geometry.js', 'text/ocr-runtime.js', 'reference/privacy-bridge.js', 'entities/wordpiece.js', 'entities/pii-runtime.js', 'controls/ui-model.js', 'controls/ui-fusion.js');

const MODEL_PATH = 'faces/ultraface-rfb-320.onnx';
const MODEL_SHA256 = 'd7c687949526065ab6a192fdf993360045ce27b0fabf7c9fca5c2437b786b495';
const BLACK = '#09090b';
const MAX_SOURCE_BYTES = 12_000_000;
const MAX_OUTPUT_BYTES = 2_500_000;
ort.env.wasm.numThreads = 1;
ort.env.wasm.simd = true;
const vendorBase = new URL('vendor/', self.location.href);
ort.env.wasm.wasmPaths = {
  mjs: new URL('ort-wasm-simd-threaded.mjs', vendorBase).href,
  wasm: new URL('ort-wasm-simd-threaded.wasm', vendorBase).href
};
let sessionPromise;

// A stuck WASM session/load must not strand a screenshot for the controller's
// entire 100-second deadline. A timeout rejects the image; it never authorizes
// a face-free or unmasked fallback. The controller terminates this worker.
async function boundedFaceModel(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Local face model timed out.')), 30000);
    })]);
  } finally { clearTimeout(timer); }
}

function session() {
  sessionPromise ||= (async () => {
    const response = await fetch(new URL(MODEL_PATH, self.location.href).href);
    if (!response.ok) throw new Error('Local face model unavailable.');
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength < 100_000 || bytes.byteLength > 3_000_000 || await sha256(bytes) !== MODEL_SHA256) {
      throw new Error('Local face model integrity failed.');
    }
    return ort.InferenceSession.create(new Uint8Array(bytes), { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
  })();
  return sessionPromise;
}

async function sha256(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
}

function imageTensor(imageData) {
  if (imageData?.width !== 320 || imageData?.height !== 240 || imageData?.data?.length !== 320 * 240 * 4) {
    throw new Error('Invalid image tensor input.');
  }
  const pixels = imageData.data, plane = 320 * 240, values = new Float32Array(plane * 3);
  for (let index = 0; index < plane; index++) {
    values[index] = (pixels[index * 4] - 127) / 128;
    values[plane + index] = (pixels[index * 4 + 1] - 127) / 128;
    values[plane * 2 + index] = (pixels[index * 4 + 2] - 127) / 128;
  }
  return new ort.Tensor('float32', values, [1, 3, 240, 320]);
}

function opaqueMask(context, box, width, height, marginX = 8, marginY = 8, alignToJpegBlocks = false) {
  const left = Math.max(0, Math.floor(box.x1 - marginX));
  const top = Math.max(0, Math.floor(box.y1 - marginY));
  const rawRight = Math.min(width, Math.ceil(box.x2 + marginX));
  const rawBottom = Math.min(height, Math.ceil(box.y2 + marginY));
  // JPEG commonly encodes chroma in 16px MCU blocks. Aligning only the
  // expanded fallback masks prevents a public-colour block from straddling a
  // protected core, which lets us keep a narrower local margin than a blanket
  // full-frame blackout.
  const x = alignToJpegBlocks ? Math.max(0, Math.floor(left / 16) * 16) : left;
  const y = alignToJpegBlocks ? Math.max(0, Math.floor(top / 16) * 16) : top;
  const right = alignToJpegBlocks ? Math.min(width, Math.ceil(rawRight / 16) * 16) : rawRight;
  const bottom = alignToJpegBlocks ? Math.min(height, Math.ceil(rawBottom / 16) * 16) : rawBottom;
  if (right <= x || bottom <= y) return null;
  // `core*` is the original sensitive geometry. It remains well inside the
  // painted rectangle and is the exact area that must stay opaque after lossy
  // JPEG encoding; the outer paint margin is intentionally allowed to absorb
  // compression bleed from nearby public pixels.
  const coreX = Math.max(0, Math.floor(box.x1));
  const coreY = Math.max(0, Math.floor(box.y1));
  const coreRight = Math.min(width, Math.ceil(box.x2));
  const coreBottom = Math.min(height, Math.ceil(box.y2));
  if (coreRight <= coreX || coreBottom <= coreY) return null;
  context.fillStyle = BLACK;
  context.fillRect(x, y, right - x, bottom - y);
  return { x, y, width: right - x, height: bottom - y,
    coreX, coreY, coreWidth: coreRight - coreX, coreHeight: coreBottom - coreY };
}

function verifyOpaqueCoverage(context, masks, width, height, decodedJpeg = false) {
  if (!masks.length) throw new Error('No verified pixel masks.');
  const image = context.getImageData(0, 0, width, height);
  if (image?.data?.length !== width * height * 4) throw new Error('Pixel readback unavailable.');
  for (const mask of masks) {
    const x = decodedJpeg ? mask.coreX : mask.x;
    const y = decodedJpeg ? mask.coreY : mask.y;
    const maskWidth = decodedJpeg ? mask.coreWidth : mask.width;
    const maskHeight = decodedJpeg ? mask.coreHeight : mask.height;
    if (![x, y, maskWidth, maskHeight].every(Number.isSafeInteger) ||
        x < 0 || y < 0 || maskWidth < 1 || maskHeight < 1 ||
        x + maskWidth > width || y + maskHeight > height) {
      throw new Error('Invalid pixel proof geometry.');
    }
    for (let row = y; row < y + maskHeight; row++) {
      for (let col = x; col < x + maskWidth; col++) {
        const index = (row * width + col) * 4;
        const opaque = decodedJpeg ? image.data[index] <= 32 && image.data[index + 1] <= 32 && image.data[index + 2] <= 32 :
          image.data[index] === 9 && image.data[index + 1] === 9 && image.data[index + 2] === 11;
        if (!opaque || image.data[index + 3] !== 255) {
          throw new Error('Masked pixel readback failed.');
        }
      }
    }
  }
}

// A detailed live page can produce a larger JPEG after selective redaction than
// an all-black fallback. Keep the proof useful where possible by trying a small
// set of bounded local quality levels. If none fits the strict outbound cap,
// the caller paints a verified full frame instead of sending a raw/oversized
// image or failing the entire browser task.
async function encodedJpegHasOpaqueProof(blob, masks, width, height) {
  globalThis.__captainVisionStage = 'jpeg-decode';
  const encodedImage = await createImageBitmap(blob);
  try {
    if (encodedImage.width !== width || encodedImage.height !== height)
      throw new Error('Encoded image dimensions changed.');
    const checkCanvas = new OffscreenCanvas(width, height);
    const checkContext = checkCanvas.getContext('2d', { alpha: false, willReadFrequently: true });
    if (!checkContext) throw new Error('Encoded image readback unavailable.');
    checkContext.drawImage(encodedImage, 0, 0);
    globalThis.__captainVisionStage = 'jpeg-verify';
    verifyOpaqueCoverage(checkContext, masks, width, height, true);
  } finally { encodedImage.close?.(); }
}

async function encodeBoundedJpeg(canvas, masks, width, height) {
  // Start at high fidelity.  The size ceiling is still enforced before any
  // bytes can leave this worker, while trying low quality first needlessly
  // altered public text even when a compact high-quality JPEG was available.
  for (const quality of [0.96, 0.92, 0.86, 0.80, 0.72, 0.60, 0.50, 0.40, 0.32, 0.25]) {
    let blob;
    try { blob = await canvas.convertToBlob({ type: 'image/jpeg', quality }); }
    catch { continue; }
    if (blob?.type !== 'image/jpeg' || blob.size < 100 || blob.size > MAX_OUTPUT_BYTES) continue;
    // A small JPEG is usable only after the actual decoded bytes keep every
    // required mask opaque. Lossy artefacts cause this quality to be rejected,
    // not merely accepted because its pre-encode canvas was black.
    try { await encodedJpegHasOpaqueProof(blob, masks, width, height); return blob; }
    catch { /* Try a higher-fidelity/next bounded encoding or fail closed. */ }
  }
  return null;
}

function mappedPrivacyRegions(request, geometry, width, height) {
  if (!geometry.safe || !Array.isArray(request.redactionBoxes) || request.redactionBoxes.length > 500 ||
    request.redactionBoxes.some(box => box?.kind === 'UNKNOWN')) return { fullBlackout: true, regions: [] };
  try {
    const regions = request.redactionBoxes.map(box => CaptainVisionCore.mapDomBox(
      box, geometry.scaleX, geometry.scaleY, width, height
    )).filter(box => box.x2 > box.x1 && box.y2 > box.y1);
    return { fullBlackout: false, regions };
  } catch {
    return { fullBlackout: true, regions: [] };
  }
}

// Only an ENTIRE OCR row known to lie inside independently identified opaque
// DOM/raster masks can be omitted. Dropping one masked word from a partly
// visible row would sever a split email/identifier and risk missing its visible
// suffix. Transitive vertical-overlap groups are deliberately broader than the
// OCR geometry's line grouping; any remaining uncertain word is later masked
// together with its full row by CaptainOCRGeometry.
function wordsOutsideVerifiedOpaqueMasks(words, domPlan, width, height) {
  if (!Array.isArray(words) || domPlan.fullBlackout || !Array.isArray(domPlan.regions)) return words;
  const covered = words.map(word => {
    if (!word || !Number.isFinite(word.confidence) ||
        typeof word.text !== 'string' || !word.text.trim() || word.text.length > 128) return false;
    const b = word.bbox;
    if (!b || ![b.x0, b.y0, b.x1, b.y1].every(Number.isFinite) ||
        b.x0 < 0 || b.y0 < 0 || b.x1 > width || b.y1 > height ||
        b.x1 <= b.x0 || b.y1 <= b.y0) return false;
    // The painter guarantees >=8 pixels outward. JPEG readback verifies its
    // interior with up to 4 pixels excluded at each edge; require each omitted
    // OCR word to fit the *verified* interior (4 px from the original box),
    // not merely into the outer painted/unchecked JPEG buffer.
    return domPlan.regions.some(mask =>
      b.x0 >= Math.max(0, mask.x1 - 4) && b.y0 >= Math.max(0, mask.y1 - 4) &&
      b.x1 <= Math.min(width, mask.x2 + 4) &&
      b.y1 <= Math.min(height, mask.y2 + 4));
  });
  const excluded = new Set();
  for (let index = 0; index < words.length; index++) {
    if (excluded.has(index) || !covered[index] || words[index].confidence >= 80) continue;
    const group = new Set([index]);
    let expanded = true;
    while (expanded) {
      expanded = false;
      for (let other = 0; other < words.length; other++) {
        if (group.has(other)) continue;
        const b = words[other]?.bbox;
        if (!b || !Number.isFinite(b.y0) || !Number.isFinite(b.y1)) continue;
        if ([...group].some(member =>
          b.y0 < words[member].bbox.y1 && b.y1 > words[member].bbox.y0)) {
          group.add(other);
          expanded = true;
        }
      }
    }
    if ([...group].every(member => covered[member]))
      for (const member of group) excluded.add(member);
  }
  return words.filter((_, index) => !excluded.has(index));
}

// Evaluation-only coarse reason for remaining low-confidence OCR. This returns
// a fixed enum, never a word, confidence, private box or screenshot coordinate.
// It cannot change the mask decision: every such unresolved word is covered by
// the OCR row mask before a JPEG proof may be issued.
function auditLowConfidenceScope(words, domPlan, width, height) {
  if (!Array.isArray(words) || !Array.isArray(domPlan?.regions)) return 'UNAVAILABLE';
  const kinds = new Set();
  for (const word of words) {
    if (Number.isFinite(word?.confidence) && word.confidence >= 80 && word.confidence <= 100) continue;
    const b = word?.bbox;
    if (!b || ![b.x0, b.y0, b.x1, b.y1].every(Number.isFinite) ||
        b.x0 < 0 || b.y0 < 0 || b.x1 > width || b.y1 > height ||
        b.x1 <= b.x0 || b.y1 <= b.y0) return 'INVALID_GEOMETRY';
    const contained = domPlan.regions.some(mask =>
      b.x0 >= Math.max(0, mask.x1 - 4) && b.y0 >= Math.max(0, mask.y1 - 4) &&
      b.x1 <= Math.min(width, mask.x2 + 4) && b.y1 <= Math.min(height, mask.y2 + 4));
    const touches = domPlan.regions.some(mask =>
      b.x0 < mask.x2 && b.x1 > mask.x1 && b.y0 < mask.y2 && b.y1 > mask.y1);
    kinds.add(contained ? 'COVERED_WORD_IN_MIXED_ROW' : touches ? 'PARTIAL_MASK_OVERLAP' : 'OUTSIDE_MASKS');
  }
  if (kinds.size === 3) return 'ALL_THREE';
  if (kinds.size === 2) {
    if (kinds.has('COVERED_WORD_IN_MIXED_ROW'))
      return kinds.has('PARTIAL_MASK_OVERLAP') ? 'COVERED_AND_PARTIAL' : 'COVERED_AND_OUTSIDE';
    return 'PARTIAL_AND_OUTSIDE';
  }
  return [...kinds][0] || 'NONE';
}

async function redact(request) {
  const started = performance.now();
  const localStageTimings = {};
  globalThis.__captainVisionStage = 'validate-input';
  if (typeof request?.screenshot !== 'string' || request.screenshot.length > 16_000_100 ||
    !/^data:image\/jpeg;base64,(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(request.screenshot)) {
    throw new Error('Invalid local screenshot input.');
  }
  globalThis.__captainVisionStage = 'decode-image';
  const response = await fetch(request.screenshot);
  if (!response.ok) throw new Error('Local screenshot unavailable.');
  const sourceBlob = await response.blob();
  if (sourceBlob.type !== 'image/jpeg' || sourceBlob.size < 100 || sourceBlob.size > MAX_SOURCE_BYTES) {
    throw new Error('Invalid local screenshot format.');
  }
  const source = await createImageBitmap(sourceBlob);
  const geometry = CaptainVisionCore.verifyCaptureGeometry(request.viewport, source.width, source.height);
  const domPlan = mappedPrivacyRegions(request, geometry, source.width, source.height);
  const resized = new OffscreenCanvas(320, 240), resizedContext = resized.getContext('2d', { alpha: false, willReadFrequently: true });
  if (!resizedContext) throw new Error('Local image canvas unavailable.');
  resizedContext.drawImage(source, 0, 0, 320, 240);
  const faceModelStarted = performance.now();
  globalThis.__captainVisionStage = 'face-model-load';
  const detector = await boundedFaceModel(session()), input = imageTensor(resizedContext.getImageData(0, 0, 320, 240));
  localStageTimings.faceModelLoadMs = Math.round(performance.now() - faceModelStarted);
  if (!Array.isArray(detector.inputNames) || detector.inputNames.length !== 1) throw new Error('Invalid face model input.');
  const inferenceStarted = performance.now();
  globalThis.__captainVisionStage = 'face-inference';
  const outputs = await boundedFaceModel(detector.run({ [detector.inputNames[0]]: input }));
  const inferenceMs = performance.now() - inferenceStarted;
  localStageTimings.faceInferenceMs = Math.round(inferenceMs);
  const tensors = outputs && typeof outputs === 'object' ? Object.values(outputs) : [];
  if (tensors.length !== 2 || tensors.some(tensor => tensor?.type !== 'float32')) throw new Error('Invalid face model output.');
  const scores = tensors.find(tensor => tensor.dims?.at(-1) === 2);
  const boxes = tensors.find(tensor => tensor.dims?.at(-1) === 4);
  if (!scores || !boxes) throw new Error('Invalid face model tensor shape.');
  const faces = CaptainVisionCore.parseUltraFace(scores.data, scores.dims, boxes.data, boxes.dims, source.width, source.height, 0.7);
  // OCR must inspect the source pixels BEFORE masks are drawn and before a v2
  // visual proof can be issued.  An absent, timed-out, unsupported or uncertain
  // model is never interpreted as evidence that pixels contain no private text.
  // In those cases the whole frame is withheld through an opaque blackout.
  globalThis.__captainVisionStage = 'local-ocr';
  const ocrStarted = performance.now();
  let ocrPlan = { fullBlackout: true, regions: [] };
  let localOcrAudit = 'UNAVAILABLE'; // fixed internal audit enum, never OCR text
  let localOcrRejectClass = 'NOT_APPLICABLE';
  let localOcrRejectScope = 'NOT_APPLICABLE';
  let localOcrRegionCount = 0, localAlternativeRegionCount = 0, localUiRegionCount = 0;
  let localOcrWords;
  let ocrTimeout;
  try {
    if (globalThis.CaptainLocalOCR?.ready === true &&
        typeof globalThis.CaptainLocalOCR.recognize === 'function' &&
        typeof globalThis.CaptainOCRGeometry?.review === 'function' &&
        typeof globalThis.CAPTAIN_PRIVACY?.scanSpans === 'function') {
      localOcrAudit = 'RUNNING';
      // A nested OCR worker can become unresponsive during shutdown even
      // after its own recognition timeout. Never keep the parent visual task
      // waiting for the controller's 100-second kill switch: ambiguity must
      // produce a full opaque frame instead of an indefinitely pending image.
      const recognized = await Promise.race([
        globalThis.CaptainLocalOCR.recognize(source, source.width, source.height),
        new Promise((_, reject) => { ocrTimeout = setTimeout(() => reject(new Error('Local OCR timed out.')), 45000); })
      ]);
      if (recognized?.complete === true) {
        const reviewWords = wordsOutsideVerifiedOpaqueMasks(recognized.words, domPlan, source.width, source.height);
        // `wordsOutsideVerifiedOpaqueMasks` removes words only when every word
        // in their OCR row is already inside a separately verified DOM/raster
        // mask. Re-running OCR review with an empty list would turn that safe
        // condition into a false whole-frame blackout.
        if (!reviewWords.length && recognized.words.length) {
          ocrPlan = { fullBlackout: false, regions: [] };
          localOcrAudit = 'ALL_WORDS_ALREADY_MASKED';
          localOcrWords = [];
        } else {
          localOcrAudit = 'REVIEWING';
          const plan = globalThis.CaptainOCRGeometry.review({ words: reviewWords, width: source.width, height: source.height });
          if (plan && typeof plan.fullBlackout === 'boolean' && Array.isArray(plan.regions)) {
            ocrPlan = plan;
            localOcrRegionCount = plan.regions.length;
            localOcrAudit = plan.fullBlackout ? 'REVIEW_BLACKOUT' : 'REVIEW_SELECTIVE';
            if (plan.fullBlackout && request.auditGateOnly === true) {
              // Aggregate reason class only: no word, confidence value, OCR box,
              // page content or private string is copied outside this worker.
              localOcrRejectClass = !reviewWords.length ? 'EMPTY' :
                reviewWords.some(word => !Number.isFinite(word.confidence) || word.confidence < 0 || word.confidence > 100)
                  ? 'INVALID_CONFIDENCE' :
                reviewWords.some(word => typeof word.text !== 'string' || !word.text.trim() || word.text.length > 128)
                  ? 'INVALID_TEXT' :
                'GEOMETRY_OR_POLICY';
            }
            if (plan.fullBlackout === false) localOcrWords = reviewWords;
          }
        }
      } else localOcrAudit = 'INCOMPLETE';
    }
  } catch { localOcrAudit = 'OCR_ERROR'; /* OCR errors can include private text; neither errors nor pixels escape. */ }
  finally { clearTimeout(ocrTimeout); }
  localStageTimings.ocrAndReviewMs = Math.round(performance.now() - ocrStarted);
  // Optional TrueSight spans may ONLY add masks. Its selected source archive
  // contains no verified matching checkpoint, so ready=false and the existing
  // OCR gate remains authoritative. An enabled but uncertain model blacks out.
  if (globalThis.CaptainTrueSight?.ready === true) {
    try {
      const result = await globalThis.CaptainTrueSight.detect(source, source.width, source.height);
      const plan = globalThis.CaptainTrueSight.review(result);
      if (!plan || plan.fullBlackout !== false || !Array.isArray(plan.regions)) {
        ocrPlan = { fullBlackout: true, regions: [] };
      } else if (!ocrPlan.fullBlackout) {
        ocrPlan = { fullBlackout: false, regions: [...ocrPlan.regions, ...plan.regions] };
      }
    } catch { ocrPlan = { fullBlackout: true, regions: [] }; }
  }
  // Independently licensed, hash-pinned Phase-07 Option B classifier. This is
  // NOT TrueSight: it receives only reliable worker-local OCR words, can only
  // add masks, and cannot negate OCR, DOM, face, UI or proof blackouts. OCR
  // rows that are non-ASCII or low-confidence are already fully opaque and are
  // deliberately not sent to the semantic classifier.
  // Never spend semantic-model time (or create a duplicate wider mask) for an
  // OCR word that is already fully covered by the deterministic OCR plan.
  // The alternate model is strictly additive for remaining high-confidence
  // text, where it can still find names/addresses not matched by the pattern
  // scanner.
  const alternativeWords = Array.isArray(localOcrWords) ? localOcrWords.filter(word => {
    const box = word?.bbox;
    const alreadyMasked = box && ocrPlan.regions.some(region =>
      box.x0 >= region.x1 && box.y0 >= region.y1 && box.x1 <= region.x2 && box.y1 <= region.y2);
    return typeof word?.text === 'string' && /^[\x20-\x7e]+$/.test(word.text) &&
      Number.isFinite(word.confidence) && word.confidence >= 80 && word.confidence <= 100 &&
      !alreadyMasked;
  }) : [];
  if (globalThis.CaptainAlternativePII?.ready === true && ocrPlan.fullBlackout === false && alternativeWords.length) {
    try {
      const extra = await globalThis.CaptainAlternativePII.detect(alternativeWords, source.width, source.height);
      if (!extra || extra.fullBlackout !== false || !Array.isArray(extra.regions)) {
        ocrPlan = { fullBlackout: true, regions: [] };
        localOcrAudit = 'ALTERNATIVE_BLACKOUT';
      } else {
        localAlternativeRegionCount = extra.regions.length;
        ocrPlan = { fullBlackout: false, regions: [...ocrPlan.regions, ...extra.regions] };
      }
    } catch { ocrPlan = { fullBlackout: true, regions: [] }; localOcrAudit = 'ALTERNATIVE_ERROR'; }
  }
  // UI detection is advisory: it can widen an already-sensitive DOM mask, but
  // cannot authorize source-pixel release, remove any mask, or create an
  // action reference. Its published checkpoint is not sufficiently accurate
  // to be a privacy-release gate, so a timeout/invalid result is ignored while
  // the independent DOM/OCR/face proof remains fail-closed.
  globalThis.__captainVisionStage = 'ui-perception';
  const uiStarted = performance.now();
  let uiPlan = { regions: [] };
  if (globalThis.CaptainUIModel?.ready === true) {
    try {
      const model = globalThis.CaptainUIModel;
      if (typeof model.detect !== 'function' || typeof globalThis.CaptainUIFusion?.review !== 'function' ||
          !/^[a-f0-9]{64}$/.test(model.modelSha256 || '') ||
          ocrPlan.fullBlackout !== false || geometry.safe !== true ||
          !Array.isArray(request.uiSnapshot?.controls) ||
          request.uiSnapshot.controls.length < 1 || request.uiSnapshot.controls.length > 250) {
        throw new Error('Local UI detector unavailable.');
      }
      // The enclosing popup terminates the worker after 100s. The optional
      // detector itself is limited more tightly and never runs while idle.
      let timer;
      const detected = await Promise.race([
        model.detect(source, source.width, source.height, request.uiSnapshot.lease),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Local UI detector unavailable.')), 8000); })
      ]).finally(() => clearTimeout(timer));
      const candidate = globalThis.CaptainUIFusion.review({
        result: detected, controls: request.uiSnapshot.controls,
        lease: request.uiSnapshot.lease, modelSha256: model.modelSha256,
        width: source.width, height: source.height, viewport: request.viewport, ocrPlan
      });
      // `review` rejects model-only/stale/private output. Its result is used
      // only when it contains validated additive rectangles.
      if (candidate?.fullBlackout === false && Array.isArray(candidate.regions) &&
          candidate.regions.length <= 64) {
        localUiRegionCount = candidate.regions.length;
        uiPlan = { regions: candidate.regions };
      }
    } catch { /* Detector output and exceptions may contain private data. */ }
  }
  localStageTimings.uiFusionMs = Math.round(performance.now() - uiStarted);
  globalThis.__captainVisionStage = 'pixel-redaction';
  const redactionStarted = performance.now();
  const output = new OffscreenCanvas(source.width, source.height), context = output.getContext('2d', { alpha: false });
  if (!context) throw new Error('Local output canvas unavailable.');
  context.drawImage(source, 0, 0);
  const { fullBlackout, regions: domBoxes } = domPlan;
  const masks = [];
  const blackout = fullBlackout || ocrPlan.fullBlackout ||
    !Array.isArray(ocrPlan.regions) || !Array.isArray(uiPlan.regions) ||
    faces.length + domBoxes.length + ocrPlan.regions.length + uiPlan.regions.length > 530;
  if (!blackout) {
    for (const face of faces) {
      const marginX = Math.max(12, (face.x2 - face.x1) * 0.45);
      const marginY = Math.max(12, (face.y2 - face.y1) * 0.55);
      const mask = opaqueMask(context, face, source.width, source.height, marginX, marginY);
      if (!mask) throw new Error('Face pixel mask unavailable.');
      masks.push(mask);
    }
    // Last pass is the DOM/raster mask; no later face operation can reveal it.
    for (const box of domBoxes) {
      const marginX = Math.max(8, (box.x2 - box.x1) * 0.04);
      const marginY = Math.max(8, (box.y2 - box.y1) * 0.04);
      const mask = opaqueMask(context, box, source.width, source.height, marginX, marginY);
      if (!mask) throw new Error('DOM pixel mask unavailable.');
      masks.push(mask);
    }
    // Final OCR pass covers image-only text (including screenshot and canvas
    // pixels) that the DOM cannot report.  Existing whole-raster masks remain
    // in force; OCR never creates planner text or a clickable cN reference.
    for (const box of ocrPlan.regions) {
      if (!box || ![box.x1, box.y1, box.x2, box.y2].every(Number.isFinite) ||
          box.x2 <= box.x1 || box.y2 <= box.y1 || box.x1 < 0 || box.y1 < 0 ||
          box.x2 > source.width || box.y2 > source.height) throw new Error('Unmaskable OCR region.');
      const mask = opaqueMask(context, box, source.width, source.height, 12, 12);
      if (!mask) throw new Error('OCR pixel mask unavailable.');
      masks.push(mask);
    }
    // UI model can widen an existing *sensitive DOM control* mask but cannot
    // release a model-only coordinate or generate a planner/action reference.
    for (const box of uiPlan.regions) {
      if (!box || ![box.x1, box.y1, box.x2, box.y2].every(Number.isFinite) ||
          box.x2 <= box.x1 || box.y2 <= box.y1 || box.x1 < 0 || box.y1 < 0 ||
          box.x2 > source.width || box.y2 > source.height) throw new Error('Unmaskable UI region.');
      const mask = opaqueMask(context, box, source.width, source.height, 12, 12);
      if (!mask) throw new Error('UI pixel mask unavailable.');
      masks.push(mask);
    }
  }
  // Missing/ambiguous geometry and empty coverage expose no source pixels.
  let fullFrameMask = blackout || !masks.length;
  if (fullFrameMask) {
    masks.length = 0;
    masks.push(opaqueMask(context, { x1: 0, y1: 0, x2: source.width, y2: source.height }, source.width, source.height, 0, 0));
  }
  verifyOpaqueCoverage(context, masks, source.width, source.height);
  globalThis.__captainVisionStage = 'jpeg-encode';
  let sanitizedBlob = await encodeBoundedJpeg(output, masks, source.width, source.height);
  if (!sanitizedBlob && !fullFrameMask) {
    // Low quality can be required for a visually detailed, high-resolution
    // page. Repaint only the existing sensitive cores with a wider local
    // margin, then re-check the actual JPEG. This preserves public context
    // whenever compression artefacts, rather than privacy ambiguity, were the
    // only obstacle.
    const cores = masks.map(mask => ({ x1: mask.coreX, y1: mask.coreY,
      x2: mask.coreX + mask.coreWidth, y2: mask.coreY + mask.coreHeight }));
    for (const margin of [12, 16, 20, 24, 28]) {
      globalThis.__captainVisionStage = 'jpeg-expanded-masks';
      context.drawImage(source, 0, 0);
      masks.length = 0;
      for (const core of cores) {
        const mask = opaqueMask(context, core, source.width, source.height, margin, margin, true);
        if (!mask) throw new Error('Expanded pixel mask unavailable.');
        masks.push(mask);
      }
      verifyOpaqueCoverage(context, masks, source.width, source.height);
      sanitizedBlob = await encodeBoundedJpeg(output, masks, source.width, source.height);
      if (sanitizedBlob) break;
    }
  }
  if (!sanitizedBlob && !fullFrameMask) {
    // No selective encoding quality fit the fixed egress limit. Replace the
    // local canvas with a fully verified opaque proof and retry once. This can
    // only reduce visual disclosure; it never sends the original screenshot.
    globalThis.__captainVisionStage = 'jpeg-blackout-fallback';
    fullFrameMask = true;
    masks.length = 0;
    masks.push(opaqueMask(context, { x1: 0, y1: 0, x2: source.width, y2: source.height }, source.width, source.height, 0, 0));
    verifyOpaqueCoverage(context, masks, source.width, source.height);
    sanitizedBlob = await encodeBoundedJpeg(output, masks, source.width, source.height);
  }
  if (!sanitizedBlob) {
    throw new Error('Sanitized screenshot exceeds the outbound limit.');
  }
  const bytes = await sanitizedBlob.arrayBuffer(), binary = new Uint8Array(bytes);
  if (binary.length !== sanitizedBlob.size || binary[0] !== 0xff || binary[1] !== 0xd8 || binary[2] !== 0xff ||
    binary.at(-2) !== 0xff || binary.at(-1) !== 0xd9) throw new Error('Sanitized JPEG integrity failed.');
  // `encodeBoundedJpeg` has decoded and checked the exact candidate JPEG.
  globalThis.__captainVisionStage = 'jpeg-digest';
  const digest = await sha256(bytes);
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('Local image digest unavailable.');
  let encoded = ''; for (let offset = 0; offset < binary.length; offset += 0x8000) encoded += String.fromCharCode(...binary.subarray(offset, offset + 0x8000));
  globalThis.__captainVisionStage = 'verified-complete';
  localStageTimings.pixelRedactionEncodeAndProofMs = Math.round(performance.now() - redactionStarted);
  // Strictly opt-in, internal-only synthetic audit reason. No raw pixels,
  // words, private fields, box geometry or model output. The production
  // service-worker proof projector ignores this extra field entirely.
  const localAuditGate = request.auditGateOnly === true ?
    (fullFrameMask && !fullBlackout && !ocrPlan.fullBlackout ? 'ENCODE_BLACKOUT' :
      fullBlackout ? 'DOM' : ocrPlan.fullBlackout ? 'OCR' :
      !masks.length ? 'EMPTY' : 'SELECTIVE') : undefined;
  return {
    screenshot: `data:image/jpeg;base64,${btoa(encoded)}`,
    ...(localAuditGate ? { localAuditGate, localOcrAudit, localOcrRejectClass, localOcrRejectScope,
      localOcrRegionCount, localAlternativeRegionCount, localUiRegionCount, localStageTimings } : {}),
    visualPrivacy: {
      schema: 'captain.visual-privacy.v2', sanitized: true, rawScreenshotTransmitted: false,
      redactionApplied: true, maskPolicy: 'opaque-raster-v1', coverageVerified: true, pixelMaskCount: masks.length,
      fullBlackout: fullFrameMask,
      domBoxes: domBoxes.length, faces: faces.length,
      faceModel: 'ultraface-rfb-320', modelSha256: MODEL_SHA256,
      imageSha256: digest, input: { width: source.width, height: source.height },
      outputBytes: sanitizedBlob.size, inferenceMs: Math.round(inferenceMs), totalMs: Math.round(performance.now() - started), backend: 'wasm'
    }
  };
}

self.onmessage = async event => {
  const id = Number.isSafeInteger(event.data?.id) ? event.data.id : null;
  try { self.postMessage({ id, ok: true, result: await redact(event.data) }); }
  catch {
    // Synthetic audit tooling may receive only this fixed stage enum. It is
    // never enabled for production planner/UI traffic and cannot contain OCR,
    // pixels, coordinates, exception text or page content.
    const stage = event.data?.auditGateOnly === true && [
      'validate-input', 'decode-image', 'face-model-load', 'face-inference',
      'local-ocr', 'ui-perception', 'pixel-redaction', 'jpeg-encode',
      'jpeg-expanded-masks', 'jpeg-blackout-fallback', 'jpeg-decode', 'jpeg-verify', 'jpeg-digest',
      'verified-complete'
    ].includes(globalThis.__captainVisionStage) ? globalThis.__captainVisionStage : 'unknown';
    self.postMessage({ id, ok: false, error: 'Local visual privacy failed.',
      ...(event.data?.auditGateOnly === true ? { stage } : {}) });
  }
};
