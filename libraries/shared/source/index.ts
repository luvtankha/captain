export type BBox = Readonly<{ x: number; y: number; width: number; height: number }>;
export type Source = 'dom' | 'text' | 'vision' | 'fused';
export interface ScreenElement { ref: `c${number}`; role: string; text: string; bbox: BBox; state: Readonly<Record<string, boolean | string>>; confidence: number; source: Source; sensitive?: boolean; sensitiveType?: string }
export interface ScreenRegion { id: string; role: string; text: string; bbox: BBox; state: Readonly<Record<string, boolean | string | number | null>>; confidence: number; source: 'DOM' | 'OCR' | 'VISION' | 'FUSED' | 'VISION_GEOMETRY' }
export interface OcrObservation { status: 'ready' | 'cached' | 'unavailable' | 'not-configured' | 'error'; regions: readonly ScreenRegion[]; cached: boolean; latencyMs?: number; cacheKey?: string; note?: string }
export interface PrivacyRegion { type: string; bbox: BBox; confidence: number; detector: string; method: 'blackout' | 'blur' | 'pixelate' | 'replace' }
export interface UnifiedScreenContext { url: string; title: string; viewport: Readonly<{ width: number; height: number; devicePixelRatio: number }>; elements: readonly ScreenElement[]; textRegions: readonly ScreenRegion[]; visualRegions: readonly ScreenRegion[]; interactiveRegions: readonly ScreenElement[]; ocr: OcrObservation; ocrRegions: readonly ScreenElement[]; visualDetections: readonly ScreenElement[]; sensitiveRegions: readonly PrivacyRegion[]; redactionRegions: readonly PrivacyRegion[]; confidence: Readonly<{ dom: number; ocr: number; vision: number; fused: number }>; screenshotMetadata?: Readonly<{ sanitized: true; format: 'image/jpeg'; bytes: number; sha256: string; rawScreenshotTransmitted: false }>; screenshot?: string; screenshotSha256?: string }
export type Action =
  | { type: 'click' | 'hover' | 'submit'; target: { ref: `c${number}` }; confidence?: number; reason?: string }
  | { type: 'type' | 'select'; target: { ref: `c${number}` }; value: string; confidence?: number; reason?: string }
  | { type: 'press'; target: { ref: `c${number}` }; key: string; confidence?: number; reason?: string }
  | { type: 'scroll'; direction: 'up' | 'down'; amount?: number; confidence?: number; reason?: string }
  | { type: 'navigate'; url: string; confidence?: number; reason?: string }
  | { type: 'back' | 'wait'; confidence?: number; reason?: string }
  | { type: 'request_local_input'; target: { ref: `c${number}` }; inputType: string; confidence?: number; reason?: string }
  | { type: 'done'; message: string; confidence?: number; reason?: string };
export interface VisionReasoningProvider { readonly id: string; plan(task: string, context: UnifiedScreenContext, history: readonly Action[]): Promise<Action> }

// Phase-01 outbound contract. These types describe the intentionally small
// server-to-planner projection; runtime enforcement lives in
// server/outbound-contract.mjs and never relies on TypeScript alone.
export type CaptainObservationSchema = 'captain.observation.v2';
export type CaptainSanitizedSchema = 'captain.sanitized.v2';
export type CaptainVisualPrivacySchema = 'captain.visual-privacy.v2';
export type CaptainAuditSchema = 'captain.audit.v1';
export type CaptainActionSchema = 'captain.action.v2';
export type CaptainPrivacyStatus = 'safe' | 'requires_review' | 'blocked';
export type CaptainPrivacyReasonCode =
  | 'TEXT_ALLOWLIST_VALIDATED' | 'VISUAL_PROOF_VALIDATED'
  | 'OCR_ERROR' | 'VISION_ERROR' | 'HUMAN_CHALLENGE' | 'UNRECOGNIZED_PRIVACY_REGION';
export type CaptainSourceClass = 'dom' | 'dom+visual';
export interface CaptainActionV2 {
  readonly schema: CaptainActionSchema;
  readonly type: 'click' | 'hover' | 'submit' | 'type' | 'select' | 'press' |
    'scroll' | 'navigate' | 'back' | 'wait' | 'request_local_input' | 'finish' | 'media';
  readonly target?: Readonly<{ ref: `c${number}` }>;
  readonly value?: string;
  readonly url?: string;
}

export interface CaptainVisualPrivacyV2 {
  readonly schema: CaptainVisualPrivacySchema;
  readonly sanitized: true;
  readonly rawScreenshotTransmitted: false;
  readonly redactionApplied: true;
  readonly faceModel: 'ultraface-rfb-320';
  readonly modelSha256: string;
  readonly imageSha256: string;
  readonly outputBytes: number;
  readonly domBoxes: number;
  readonly faces: number;
  readonly inferenceMs: number;
  readonly totalMs: number;
  readonly migratedFrom?: 'captain.visual-privacy.v1';
}
export interface CaptainAuditV1 {
  readonly schema: CaptainAuditSchema;
  readonly sourceSchema: CaptainObservationSchema | 'captain.observation.legacy';
  readonly projectionSchema: CaptainSanitizedSchema;
  readonly visualProof: 'none' | 'v2' | 'migrated-v1';
  readonly privacyStatus: CaptainPrivacyStatus;
  readonly sourceClass: CaptainSourceClass;
  readonly detectorProofVersion: 'none' | CaptainVisualPrivacySchema;
  readonly reasonCodes: readonly CaptainPrivacyReasonCode[];
}
export interface CaptainObservationV2 {
  readonly schema: CaptainObservationSchema;
  readonly task: string;
  readonly context: Readonly<Record<string, unknown>>;
  readonly history?: readonly Readonly<Record<string, unknown>>[];
}
export interface CaptainSanitizedV2 {
  readonly schema: CaptainSanitizedSchema;
  readonly task: string;
  readonly context: Readonly<Record<string, unknown>> & {
    readonly screenshot?: string;
    readonly visualPrivacy?: CaptainVisualPrivacyV2;
  };
  readonly history: readonly Readonly<Record<string, unknown>>[];
  readonly audit: CaptainAuditV1;
}
