// Conservative, one-to-one geometry scores for INDEPENDENT fixture DOM labels.
// These do not measure the separate ONNX visual detector or real-web accuracy.
export function iou(a, b) {
  const valid = r => r && [r.x, r.y, r.width, r.height].every(Number.isFinite) &&
    r.width > 0 && r.height > 0;
  if (!valid(a) || !valid(b)) return 0;
  const w = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const h = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  const intersection = w * h;
  const union = a.width * a.height + b.width * b.height - intersection;
  return union > 0 ? intersection / union : 0;
}

export function matchControls(truth, observed, threshold = 0.5) {
  if (!Array.isArray(truth) || !Array.isArray(observed) ||
      !Number.isFinite(threshold) || threshold <= 0 || threshold > 1)
    throw new Error('Invalid labelled control evaluation.');
  const possible = [];
  for (let ti = 0; ti < truth.length; ti++) for (let oi = 0; oi < observed.length; oi++) {
    if (truth[ti]?.tag !== observed[oi]?.tag) continue;
    const overlap = iou(truth[ti].bbox, observed[oi].bbox);
    if (overlap >= threshold) possible.push({ ti, oi, overlap });
  }
  possible.sort((a, b) => b.overlap - a.overlap || a.ti - b.ti || a.oi - b.oi);
  const usedTruth = new Set(), usedObserved = new Set(), matches = [];
  for (const item of possible) {
    if (usedTruth.has(item.ti) || usedObserved.has(item.oi)) continue;
    usedTruth.add(item.ti); usedObserved.add(item.oi);
    matches.push({ truthIndex: item.ti, observedIndex: item.oi, iou: item.overlap });
  }
  return { tp: matches.length, fp: observed.length - matches.length,
    fn: truth.length - matches.length, matches };
}

export function matchKinds(expected, observed) {
  if (!Array.isArray(expected) || !Array.isArray(observed))
    throw new Error('Invalid labelled private-kind evaluation.');
  const remaining = [...observed]; let tp = 0;
  for (const kind of expected) {
    const i = remaining.indexOf(kind);
    if (i !== -1) { remaining.splice(i, 1); tp++; }
  }
  return { tp, fp: remaining.length, fn: expected.length - tp };
}

export function summarize(values) {
  if (!Array.isArray(values) || values.some(v => !Number.isFinite(v) || v < 0))
    throw new Error('Only nonnegative numeric timing samples are allowed.');
  if (!values.length) return { count: 0, meanMs: null, p50Ms: null, p95Ms: null };
  const sorted = [...values].sort((a, b) => a - b);
  const round = v => Math.round(v * 100) / 100;
  return { count: sorted.length, meanMs: round(sorted.reduce((a,b)=>a+b,0)/sorted.length),
    p50Ms: round(sorted[Math.ceil(sorted.length*.5)-1]),
    p95Ms: round(sorted[Math.ceil(sorted.length*.95)-1]) };
}

export function rates({ tp, fp, fn }) {
  return { tp, fp, fn,
    precision: tp + fp ? tp / (tp + fp) : null,
    recall: tp + fn ? tp / (tp + fn) : null };
}
