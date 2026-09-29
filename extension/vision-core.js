(function (root) {
  const REGION_TYPES = new Set([
    'PII', 'UNKNOWN', 'RASTER_CONTENT', 'BACKGROUND_IMAGE', 'SECRET', 'EMAIL', 'PHONE',
    'CARD', 'AADHAAR', 'PAN', 'PASSWORD', 'OTP', 'PIN', 'CVV', 'TOKEN', 'API_KEY',
    'CREDENTIAL', 'PERSON', 'NAME', 'FULL_NAME', 'ADDRESS', 'DATE_OF_BIRTH', 'DOB',
    'PASSPORT', 'PASSPORT_NUMBER', 'ACCOUNT', 'ACCOUNT_NUMBER', 'IFSC',
    'email', 'phone', 'card', 'aadhaar', 'pan', 'secret', 'password', 'otp', 'pin',
    'cvv', 'token', 'api-key', 'security-answer'
  ]);
  const validNumber = value => typeof value === 'number' && Number.isFinite(value);
  function validSourceDimensions(width, height) {
    return Number.isSafeInteger(width) && Number.isSafeInteger(height) && width > 0 && height > 0 &&
      width <= 100_000 && height <= 100_000 && width * height <= 12_000_000;
  }
  function verifyCaptureGeometry(viewport, width, height) {
    if (!validSourceDimensions(width, height)) throw new Error('Invalid image dimensions.');
    if (!viewport || !validNumber(viewport.width) || !validNumber(viewport.height) ||
      !validNumber(viewport.devicePixelRatio) || viewport.width <= 0 || viewport.height <= 0 ||
      viewport.width > 100_000 || viewport.height > 100_000 ||
      viewport.devicePixelRatio < 0.01 || viewport.devicePixelRatio > 100) return { safe: false };
    const scaleX = width / viewport.width, scaleY = height / viewport.height;
    const ratio = Math.max(scaleX, scaleY) / Math.min(scaleX, scaleY);
    const dprRatio = Math.max(scaleX, viewport.devicePixelRatio) / Math.min(scaleX, viewport.devicePixelRatio);
    if (!Number.isFinite(ratio) || !Number.isFinite(dprRatio) || ratio > 1.02 || dprRatio > 1.1 ||
      scaleX < 0.1 || scaleX > 100) return { safe: false };
    return { safe: true, scaleX, scaleY };
  }
  function clamp(value, low, high) { return Math.min(high, Math.max(low, value)); }
  function iou(a, b) {
    const left = Math.max(a.x1, b.x1), top = Math.max(a.y1, b.y1);
    const right = Math.min(a.x2, b.x2), bottom = Math.min(a.y2, b.y2);
    const intersection = Math.max(0, right - left) * Math.max(0, bottom - top);
    const union = Math.max(0, a.x2 - a.x1) * Math.max(0, a.y2 - a.y1) + Math.max(0, b.x2 - b.x1) * Math.max(0, b.y2 - b.y1) - intersection;
    return union > 0 ? intersection / union : 0;
  }
  function nms(candidates, threshold = 0.3, limit = 30) {
    const sorted = [...candidates].sort((a, b) => b.score - a.score), kept = [];
    while (sorted.length && kept.length < limit) {
      const current = sorted.shift(); kept.push(current);
      for (let index = sorted.length - 1; index >= 0; index--) if (iou(current, sorted[index]) > threshold) sorted.splice(index, 1);
    }
    return kept;
  }
  function parseUltraFace(scores, scoreDims, boxes, boxDims, width, height, threshold = 0.7) {
    if (!validSourceDimensions(width, height) || !validNumber(threshold) || threshold <= 0 || threshold > 1 ||
      !Array.isArray(scoreDims) || !Array.isArray(boxDims) || scoreDims.length !== 3 || boxDims.length !== 3 ||
      scoreDims[0] !== 1 || boxDims[0] !== 1 || scoreDims[2] !== 2 || boxDims[2] !== 4 ||
      !Number.isSafeInteger(scoreDims[1]) || scoreDims[1] < 1 || scoreDims[1] > 50_000 ||
      scoreDims[1] !== boxDims[1] || !ArrayBuffer.isView(scores) || !ArrayBuffer.isView(boxes) ||
      scores.length !== scoreDims[1] * 2 || boxes.length !== boxDims[1] * 4) throw new Error('Invalid face tensor contract.');
    const candidates = [];
    for (let index = 0; index < scoreDims[1]; index++) {
      const background = scores[index * 2], score = scores[index * 2 + 1];
      const coordinates = boxes.subarray(index * 4, index * 4 + 4);
      if (![background, score, ...coordinates].every(validNumber) || background < 0 || background > 1 ||
        score < 0 || score > 1) throw new Error('Invalid face tensor value.');
      if (score < threshold) continue;
      const [left, top, right, bottom] = coordinates;
      if (right <= left || bottom <= top || left < -1 || top < -1 || right > 2 || bottom > 2) throw new Error('Invalid face geometry.');
      const x1 = clamp(left * width, 0, width), y1 = clamp(top * height, 0, height);
      const x2 = clamp(right * width, 0, width), y2 = clamp(bottom * height, 0, height);
      if (x2 <= x1 || y2 <= y1) throw new Error('Unmaskable face geometry.');
      candidates.push({ x1, y1, x2, y2, score });
    }
    const kept = nms(candidates, 0.3, 31);
    if (kept.length > 30) throw new Error('Face detector exceeded mask limit.');
    return kept;
  }
  function mapDomBox(box, scaleX, scaleY, width, height) {
    if (!box || !validSourceDimensions(width, height) || !validNumber(scaleX) || !validNumber(scaleY) ||
      scaleX <= 0 || scaleY <= 0 || ![box.x, box.y, box.width, box.height].every(validNumber) ||
      box.width <= 0 || box.height <= 0 || !Number.isFinite(box.x + box.width) ||
      !Number.isFinite(box.y + box.height) || !REGION_TYPES.has(box.kind === undefined ? 'PII' : box.kind)) {
      throw new Error('Invalid privacy region geometry.');
    }
    const x1 = clamp(box.x * scaleX, 0, width), y1 = clamp(box.y * scaleY, 0, height);
    const x2 = clamp((box.x + box.width) * scaleX, 0, width), y2 = clamp((box.y + box.height) * scaleY, 0, height);
    return { x1, y1, x2, y2, kind: box.kind === undefined ? 'PII' : box.kind };
  }
  root.CaptainVisionCore = { clamp, iou, nms, parseUltraFace, mapDomBox, verifyCaptureGeometry };
})(globalThis);
