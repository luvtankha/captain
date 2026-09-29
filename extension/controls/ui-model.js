// CAPTAIN Phase-06. Optional, extension-local YOLOv5n UI-element detector.
// This adapter never emits text, identifiers, selectors or actionable targets.
// The separate fusion gate admits only a verified match to a fresh DOM cN.
(function (root) {
  'use strict';
  const ERROR = 'Local UI detector unavailable.';
  const MODEL = 'controls/model.onnx';
  const SHA = 'd29b6210d171e3dc5454e09847aaabce6a0255eaefa565b639e1301a9e933ef9';
  const SIZE = 7481347, SIDE = 640, MAX_PIXELS = 12_000_000;
  const OUTPUTS = Object.freeze({ output0: 19200, '343': 4800, '378': 1200 });
  const CONFIDENCE = 0.75, IOU = 0.45, MAX_CANDIDATES = 1024, MAX_DETECTIONS = 64;
  let sessionPromise;
  async function load() {
    sessionPromise ||= (async () => {
      if (!root.ort?.InferenceSession || !root.ort?.Tensor || !root.crypto?.subtle || !root.self?.location?.href) throw new Error(ERROR);
      const url = new URL(MODEL, root.self.location.href);
      if (url.protocol !== new URL(root.self.location.href).protocol || url.host !== new URL(root.self.location.href).host) throw new Error(ERROR);
      const response = await root.fetch(url.href);
      if (!response.ok) throw new Error(ERROR);
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength !== SIZE) throw new Error(ERROR);
      const hash = [...new Uint8Array(await root.crypto.subtle.digest('SHA-256', bytes))]
        .map(byte => byte.toString(16).padStart(2, '0')).join('');
      if (hash !== SHA) throw new Error(ERROR);
      const runtime = await root.ort.InferenceSession.create(new Uint8Array(bytes), {
        executionProviders: ['wasm'], graphOptimizationLevel: 'all'
      });
      if (runtime.inputNames?.length !== 1 || runtime.inputNames[0] !== 'images' ||
          runtime.outputNames?.length !== 3 ||
          runtime.outputNames.some(name => !Object.hasOwn(OUTPUTS, name))) throw new Error(ERROR);
      return runtime;
    })();
    return sessionPromise;
  }
  function intersect(a, b) {
    const w = Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1));
    const h = Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1));
    const intersection = w * h;
    return intersection / ((a.x2 - a.x1) * (a.y2 - a.y1) + (b.x2 - b.x1) * (b.y2 - b.y1) - intersection);
  }
  function decode(outputs, width, height, scale, offsetX, offsetY) {
    if (!outputs || Object.keys(outputs).length !== 3 ||
        Object.keys(outputs).some(name => !Object.hasOwn(OUTPUTS, name))) throw new Error(ERROR);
    const candidates = [];
    for (const [name, count] of Object.entries(OUTPUTS)) {
      const tensor = outputs[name];
      if (tensor?.type !== 'float32' || tensor.dims?.length !== 3 ||
          tensor.dims[0] !== 1 || tensor.dims[1] !== count || tensor.dims[2] !== 6 ||
          tensor.data?.length !== count * 6) throw new Error(ERROR);
      for (let index = 0; index < tensor.data.length; index += 6) {
        const data = tensor.data;
        for (let part = 0; part < 6; part++) if (!Number.isFinite(data[index + part])) throw new Error(ERROR);
        const confidence = data[index + 4] * data[index + 5];
        if (confidence < CONFIDENCE) continue;
        if (confidence > 1 || data[index + 4] < 0 || data[index + 5] < 0 ||
            data[index + 4] > 1 || data[index + 5] > 1 || data[index + 2] <= 0 || data[index + 3] <= 0) throw new Error(ERROR);
        const x1 = (data[index] - data[index + 2] / 2 - offsetX) / scale;
        const y1 = (data[index + 1] - data[index + 3] / 2 - offsetY) / scale;
        const x2 = (data[index] + data[index + 2] / 2 - offsetX) / scale;
        const y2 = (data[index + 1] + data[index + 3] / 2 - offsetY) / scale;
        // A confident region outside the actual screenshot or in the padding
        // cannot be transformed safely: black out, rather than silently drop.
        if (x1 < 0 || y1 < 0 || x2 > width || y2 > height || x2 <= x1 || y2 <= y1) throw new Error(ERROR);
        candidates.push({ kind: 'control', confidence, box: { x1, y1, x2, y2 } });
        if (candidates.length > MAX_CANDIDATES) throw new Error(ERROR);
      }
    }
    candidates.sort((a, b) => b.confidence - a.confidence);
    const detections = [];
    for (const candidate of candidates) {
      if (detections.every(kept => intersect(candidate.box, kept.box) <= IOU)) {
        detections.push(candidate);
        if (detections.length > MAX_DETECTIONS) throw new Error(ERROR);
      }
    }
    // Empty output is explicitly NOT a successful visual privacy release:
    // ui-fusion will conservatively require full-frame blackout.
    return detections;
  }
  async function detect(bitmap, width, height, lease) {
    try {
      if (!bitmap || bitmap.width !== width || bitmap.height !== height ||
          !Number.isSafeInteger(width) || !Number.isSafeInteger(height) ||
          width < 1 || height < 1 || width * height > MAX_PIXELS || !lease ||
          !Number.isSafeInteger(lease.domRevision) || !Number.isSafeInteger(lease.geometryRevision)) throw new Error(ERROR);
      const detector = await load();
      const scale = Math.min(SIDE / width, SIDE / height);
      const drawWidth = Math.round(width * scale), drawHeight = Math.round(height * scale);
      const offsetX = Math.floor((SIDE - drawWidth) / 2), offsetY = Math.floor((SIDE - drawHeight) / 2);
      if (!drawWidth || !drawHeight) throw new Error(ERROR);
      const canvas = new OffscreenCanvas(SIDE, SIDE);
      const context = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
      if (!context) throw new Error(ERROR);
      context.fillStyle = '#727272'; context.fillRect(0, 0, SIDE, SIDE);
      context.drawImage(bitmap, 0, 0, width, height, offsetX, offsetY, drawWidth, drawHeight);
      const rgba = context.getImageData(0, 0, SIDE, SIDE).data;
      if (rgba.length !== SIDE * SIDE * 4) throw new Error(ERROR);
      const plane = SIDE * SIDE, values = new Float32Array(plane * 3);
      for (let pixel = 0; pixel < plane; pixel++) {
        values[pixel] = rgba[pixel * 4] / 255;
        values[plane + pixel] = rgba[pixel * 4 + 1] / 255;
        values[plane * 2 + pixel] = rgba[pixel * 4 + 2] / 255;
      }
      const outputs = await detector.run({ images: new root.ort.Tensor('float32', values, [1, 3, SIDE, SIDE]) });
      return { complete: true, source: 'ui-element-onnx', modelSha256: SHA, width, height,
        lease, detections: decode(outputs, width, height, scale, offsetX, offsetY) };
    } catch { throw new Error(ERROR); }
  }
  root.CaptainUIModel = Object.freeze({ ready: true, source: 'ui-element-onnx', modelSha256: SHA,
    quantization: 'FP32, upstream exported ONNX opset 12; no quantization claimed',
    runtime: 'onnxruntime-web@1.30.0/wasm', detect });
})(globalThis);
