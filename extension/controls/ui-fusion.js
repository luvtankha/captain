// Private extension-only geometry fusion for a future independently validated
// UI-element detector. Nothing here creates cN references or authorizes actions.
// Raw detections, model text and embeddings never enter outbound observations.
(function (root) {
  'use strict';
  const SOURCE = 'ui-element-onnx';
  const FAIL = Object.freeze({ fullBlackout: true, regions: [], matchedRefs: [] });
  const MAX_CONTROLS = 250, MAX_DETECTIONS = 64, MIN_CONFIDENCE = 0.75;
  const keysOnly = (value, allowed) => value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).every(key => allowed.includes(key));
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const integer = value => Number.isSafeInteger(value) && value >= 0;
  const SHA = /^[a-f0-9]{64}$/;
  const refPattern = /^c[1-9][0-9]{0,5}$/;
  function leaseOK(lease) {
    return keysOnly(lease, ['documentToken', 'observationId', 'domRevision', 'geometryRevision']) &&
      typeof lease.documentToken === 'string' && lease.documentToken.length >= 8 && lease.documentToken.length <= 128 &&
      typeof lease.observationId === 'string' && lease.observationId.length >= 8 && lease.observationId.length <= 128 &&
      integer(lease.domRevision) && integer(lease.geometryRevision);
  }
  function equalLease(first, second) {
    return leaseOK(first) && leaseOK(second) &&
      first.documentToken === second.documentToken && first.observationId === second.observationId &&
      first.domRevision === second.domRevision && first.geometryRevision === second.geometryRevision;
  }
  function validBox(box, width, height) {
    return keysOnly(box, ['x1', 'y1', 'x2', 'y2']) &&
      [box.x1, box.y1, box.x2, box.y2].every(finite) &&
      box.x1 >= 0 && box.y1 >= 0 && box.x2 <= width && box.y2 <= height &&
      box.x2 > box.x1 && box.y2 > box.y1;
  }
  function overlap(a, b) {
    const x = Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1));
    const y = Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1));
    const inter = x * y;
    const areaA = (a.x2 - a.x1) * (a.y2 - a.y1);
    const areaB = (b.x2 - b.x1) * (b.y2 - b.y1);
    return inter / (areaA + areaB - inter);
  }
  function review({ result, controls, lease, modelSha256, width, height, viewport, ocrPlan } = {}) {
    try {
      if (!integer(width) || !integer(height) || width < 1 || height < 1 || width * height > 12_000_000 ||
          !viewport || ![viewport.width, viewport.height, viewport.devicePixelRatio].every(finite) ||
          viewport.width <= 0 || viewport.height <= 0 || viewport.devicePixelRatio <= 0 ||
          viewport.devicePixelRatio > 8 || !SHA.test(modelSha256) ||
          !ocrPlan || ocrPlan.fullBlackout !== false || !Array.isArray(ocrPlan.regions) ||
          !keysOnly(result, ['complete', 'source', 'modelSha256', 'width', 'height', 'lease', 'detections']) ||
          result.complete !== true || result.source !== SOURCE || result.modelSha256 !== modelSha256 ||
          result.width !== width || result.height !== height || !equalLease(lease, result.lease) ||
          !Array.isArray(result.detections) || !result.detections.length || result.detections.length > MAX_DETECTIONS ||
          !Array.isArray(controls) || controls.length > MAX_CONTROLS) return FAIL;
      const scaleX = width / viewport.width, scaleY = height / viewport.height;
      if (!finite(scaleX) || !finite(scaleY) || scaleX < 0.1 || scaleX > 100 ||
          Math.max(scaleX, scaleY) / Math.min(scaleX, scaleY) > 1.02 ||
          Math.max(scaleX, viewport.devicePixelRatio) / Math.min(scaleX, viewport.devicePixelRatio) > 1.1) return FAIL;
      const dom = [], seen = new Set();
      for (const control of controls) {
        if (!keysOnly(control, ['ref', 'box', 'source', 'visible', 'enabled', 'sensitive', 'lease']) ||
            !refPattern.test(control.ref) || seen.has(control.ref) || control.source !== 'dom' ||
            control.visible !== true || typeof control.enabled !== 'boolean' ||
            typeof control.sensitive !== 'boolean' || !equalLease(lease, control.lease) ||
            !control.box || !keysOnly(control.box, ['x', 'y', 'width', 'height']) ||
            ![control.box.x, control.box.y, control.box.width, control.box.height].every(finite) ||
            control.box.width <= 0 || control.box.height <= 0) return FAIL;
        seen.add(control.ref);
        const box = {
          x1: control.box.x * scaleX, y1: control.box.y * scaleY,
          x2: (control.box.x + control.box.width) * scaleX,
          y2: (control.box.y + control.box.height) * scaleY
        };
        if (!validBox(box, width, height)) return FAIL;
        dom.push({ ref: control.ref, box, sensitive: control.sensitive });
      }
      const matchedRefs = [], regions = [];
      for (const detection of result.detections) {
        // Reject extra fields such as raw labels, OCR text, embeddings,
        // private values, CSS selectors or synthesized action references.
        if (!keysOnly(detection, ['kind', 'confidence', 'box']) || detection.kind !== 'control' ||
            !finite(detection.confidence) || detection.confidence < MIN_CONFIDENCE ||
            detection.confidence > 1 || !validBox(detection.box, width, height)) return FAIL;
        const matches = dom.filter(control => overlap(control.box, detection.box) >= 0.5);
        // One genuine current DOM control is the only possible source of cN.
        // Model-only or ambiguous objects black out the frame; never click.
        if (matches.length !== 1 || matchedRefs.includes(matches[0].ref)) return FAIL;
        matchedRefs.push(matches[0].ref);
        if (matches[0].sensitive) regions.push({
          x1: Math.min(matches[0].box.x1, detection.box.x1),
          y1: Math.min(matches[0].box.y1, detection.box.y1),
          x2: Math.max(matches[0].box.x2, detection.box.x2),
          y2: Math.max(matches[0].box.y2, detection.box.y2)
        });
      }
      // This is a local-only result. Callers may consume ONLY regions and
      // blackout for image masking; matchedRefs must never cross egress.
      return { fullBlackout: false, regions, matchedRefs };
    } catch { return FAIL; }
  }
  root.CaptainUIFusion = Object.freeze({ review });
})(globalThis);
