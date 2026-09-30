# CAPTAIN

CAPTAIN is a privacy-first browser agent built for the Smart India Hackathon 2026 Final Round under SIH26171 — On-device Visual Perception for Light-weight Browser Agents. It runs as a Manifest V3 browser extension with a local companion service, observes webpages locally, detects sensitive information before planning, redacts protected regions, asks for consent when required, and executes only validated browser actions.

The project is designed so raw sensitive values and unverified screenshots do not need to leave the browser privacy boundary.

## SIH presentation

- [CAPTAIN SIH 2026 presentation](presentation/CAPTAIN-SIH-2026.pptx) — official-template deck with architecture, workflow, benefits, and annotated reference links.
- The deck's feasibility slide cites the 29 September 2026 test snapshot. The newer evaluation results and remaining limitations below are the current project status.

## Core capabilities

- Typed browser commands through the page panel or extension controller.
- Safe navigation to explicit HTTP(S) destinations and known aliases.
- Local page observation using DOM information, OCR, and ONNX-based vision components.
- Detection of sensitive fields such as passwords, OTPs, payment details, email addresses, phone numbers, identity information, and addresses.
- Visible privacy markers on detected sensitive regions.
- A local-only masked preview before protected context is used.
- User consent before continuing when sensitive regions are present.
- Proof-bound sanitized visual context for the local planner.
- Protected-input blocking for passwords, OTPs, PINs, card data, tokens, API keys, and similar secrets.
- Validation of tab, URL, document state, target identity, and action leases before execution.
- Verification after supported actions instead of treating a click as automatic success.

## How CAPTAIN works

```text
User command
    |
    v
Command validation
    |
    v
Normal-tab navigation / current-page observation
    |
    v
Local DOM + OCR + vision privacy scan
    |
    v
Sensitive-region masking and privacy proof
    |
    +---- sensitive data detected ----> user consent
    |                                      |
    |                                      +---- Stop
    |                                      |
    |                                      +---- Continue without sharing
    |
    v
Sanitized context only
    |
    v
Authenticated local companion / planner
    |
    v
Action validation
    |
    v
Browser execution
    |
    v
Result verification
```

## Privacy model

CAPTAIN performs sensitive-data detection locally before planner context is created.

The extension:

- keeps raw capture processing inside extension contexts;
- converts detected private regions into masks;
- exposes generic withheld categories instead of copying sensitive values;
- rejects stale observations when the page, viewport, URL, or document identity changes;
- does not authorize a screenshot unless the outgoing privacy proof matches it;
- omits an image from planner context when the visual privacy pipeline cannot verify it safely;
- requires fresh observation after consent instead of reusing an older capture;
- blocks remote entry or submission of protected credentials and secret values.

Incognito targets and unsupported browser-internal pages are not part of the supported execution path.

## Main components

| Component | Responsibility |
| --- | --- |
| `extension/content-script.js` | In-page panel, DOM observation, sensitive-field detection, page markers, and page-side safety checks. |
| `extension/service-worker.js` | Tab binding, navigation, capture coordination, consent state, action leases, and browser execution. |
| `extension/popup.js` | Command input, task state, cancellation, and visual-processing coordination. |
| `extension/vision-worker.js` | Local OCR/vision checks, masking, and visual privacy proof generation. |
| `extension/privacy/` | Local privacy-boundary logic. |
| `server/index.mjs` | Authenticated loopback companion service. |
| `server/planner.mjs` | Local/deterministic planning and action-schema validation. |
| `server/outbound-contract.mjs` | Validation of data allowed to cross the local privacy boundary. |
| `server/result-verifier.mjs` | Verification of supported task outcomes. |
| `tests/` | Privacy, browser-action, regression, and integration tests. |
| `tools/` | Demo launcher, diagnostics, audits, packaging, and browser test utilities. |

## Requirements

- Windows
- Node.js 22 or later
- npm
- Chrome or Microsoft Edge

An optional locally installed Ollama model can be configured for local planning. Normal deterministic tasks do not require an external API key.

## Installation

From the project directory:

```powershell
npm.cmd ci --no-audit --no-fund
```

Create local configuration from the example if you need to change defaults:

```powershell
Copy-Item .env.example .env
```

The default companion port is `4317`.

## Run CAPTAIN

Start the complete browser demo:

```powershell
npm.cmd run demo
```

The launcher starts the local companion, loads the unpacked extension, and opens or reuses CAPTAIN's dedicated normal browser window.

After source changes:

```powershell
npm.cmd run demo -- --reload
```

You can also use:

```powershell
.\START-CAPTAIN.cmd
```

To start only the local companion service:

```powershell
npm.cmd start
```

## Using the browser agent

1. Open a normal website tab inside CAPTAIN's browser window.
2. Hold **E for 4 seconds** outside an editable field to open the compact page panel and run a local privacy scan.
3. Review the detected withheld categories and masked local preview.
4. Enter a command such as `open github.com/login`.
5. Press **Enter** or select **RUN**.
6. If sensitive information is detected, choose whether to continue without sharing it or stop the task.
7. CAPTAIN creates a fresh privacy-safe observation before planning and validates every supported action against the current page state.

The panel ignores the hold shortcut while focus is inside text fields or editable areas.

## Protected information

CAPTAIN is designed not to type, select, submit, or request protected values such as:

- passwords;
- OTPs and PINs;
- payment-card numbers and CVVs;
- access tokens and API keys;
- other credential-like secrets.

It may navigate to a login page, but when completing the task would require protected credential access, execution stops and returns control to the user.

## Testing

Run the automated regression suite:

```powershell
npm.cmd test
```

Run syntax and TypeScript checks:

```powershell
npm.cmd run lint
```

Useful browser/privacy checks:

```powershell
npm.cmd run test:websites
npm.cmd run test:coverage
npm.cmd run test:visual-privacy
npm.cmd run test:text-panel
npm.cmd run diagnose
```

Some live browser tests require the demo launcher to be running and depend on the current behavior of third-party websites.

### Reproducible readiness evidence

Start the demo, leave it idle, then run:

```powershell
npm.cmd run benchmark:readiness
```

This sequential suite writes `runtime/readiness-evaluation.json` and five scoped reports, preserving per-run copies with SHA-256 hashes under `runtime/readiness-runs/`. It rejects stale reports and a source change during evaluation. A failed quality gate returns a nonzero exit code even when every case executed. Timing runs are sequential to avoid competition from the other suites; other applications can still affect measurements.

| Command | What it measures | What it does not establish |
| --- | --- | --- |
| `npm.cmd run test:evidence` | Fresh software-test totals, per-file counts, exclusive filename-based categories | Live website success or acoustic/visual accuracy |
| `npm.cmd run benchmark` | 40 controlled DOM cases; one-to-one geometry matching at IoU ≥ 0.5; private-kind count agreement | Vision-model accuracy or spatial PII recall |
| `npm.cmd run benchmark:vision` | Actual SHA-pinned production ONNX on 13 synthetic browser layouts; TP/FP/FN, precision/recall, IoU, p50/p95 | Unseen holdout performance or representative web coverage |
| `npm.cmd run benchmark:ocr` | Actual packaged English OCR on 24 text rasters: two fonts, three sizes, two themes, two scales; CER/WER and p50/p95 | Multilingual OCR or real-page screenshot accuracy |
| `npm.cmd run benchmark:resources` | Model SHA-256/bytes, packaged footprint if present, CPU and RSS of an isolated Node-hosted UI inference run | Combined extension, companion, OCR and browser peak resources |
| `npm.cmd run test:coverage` | Live public navigation and an expected credential handoff in an owned tab; all-attempt timings | 20–50 varied tasks, login success, or universal coverage |

OCR's provisional diagnostic gate requires **every** case, as well as the aggregate, to have CER ≤ 5% and WER ≤ 10%. This is a declared controlled-corpus threshold, not a security acceptance standard. Failed recognition is counted as failure, not discarded. Vision's strict controlled gate requires all labelled elements and no false positives. Previously inspected fixtures are not labelled independent held-out data.

The current normal-window audit has observed **TP3/FP1/FN40** across 43 labelled UI controls. This is a failing visual-quality result. Historical private-window evidence reported **TP0/FP0/FN43** and **0/5** selective image-preservation cases; it remains historical evidence, not a current pass. Window geometry changes can change model results. The local field-only PNG preview is also not proof that the outgoing JPEG preserved public content.

Read the report timestamps and source fingerprints before citing numbers. Generated reports remain local; share only reviewed numeric reports, never browser profiles, tokens, raw captures, or OCR strings. Research candidates are excluded from production extension packages. Normal operation and current audits use **normal tabs**. Firefox packaging checks are static: they do not establish Firefox runtime support. Consequential actions still require approval; CAPTCHA and protected credentials still require human control.

### Exact local perception stack

| Layer | Packaged asset | Size (bytes) | Role / restriction |
| --- | --- | ---: | --- |
| UI vision | Carwin YOLOv5n FP32 ONNX | 7,481,347 | 640×640 input, single `element` class, confidence 0.75, NMS IoU 0.45; poor measured recall; no autonomous model-only click |
| PII entities | Gravitee BERT-small quantized ONNX | 28,732,710 | Independent local PII model; not TrueSight |
| Faces | UltraFace RFB320 ONNX | 1,163,666 | Local face-region proposals for masking |
| OCR language | Tesseract English compressed trained data | 2,952,873 | Local English/Latin OCR; fonts and contrast affect accuracy |

These four assets total **40,330,596 bytes**, excluding JavaScript, WASM runtimes, tokenizers, the browser and Node. The benchmark records actual hashes and footprint; this total alone does not prove the whole agent is lightweight. ONNX uses CPU/WASM; the resource benchmark does not use a dedicated GPU. The UI model's upstream MIT model-card claim and YOLOv5 AGPL lineage still need distribution/legal review. Preserve the supplied notices; do not claim MIT-only clearance.

Deterministic tasks use rules. The launcher only probes/starts Ollama when `CAPTAIN_OLLAMA_MODEL` is explicitly configured. Quoted `.env` values and process-environment overrides are interpreted consistently by launcher and companion. The companion provides authenticated loopback planning, contracts and outcome verification; removing it would be an architectural change, not an installation fix.

### Privacy boundary and action policy

| Data / threat | Current boundary or mitigation | Residual limitation |
| --- | --- | --- |
| Raw screenshot, OCR words, sensitive values | Extension-local processing; generic withheld categories in UI | Local device/browser compromise is outside this boundary |
| Planner context | Sanitized structured observation; outgoing JPEG requires matching privacy proof | A proof verifies processing/integrity, not perfect detection recall |
| Low-confidence perception | Mask uncertain regions, blackout or omit image | Can remove useful public context; not successful selective vision |
| Webpage prompt injection | Untrusted page data; bounded planner/action schema and local validation | Regression evidence is not a complete security assessment |
| Stale page, URL or target | Fresh observation, document/geometry/target binding and action leases | Dynamic pages may require retries or stop |
| Protected credentials, CAPTCHA, consequential actions | Human handoff or locally bound approval; no bypass | Intended safety boundary, not a task-completion success |
| Remote VLM option | Sanitized context only through validated outbound contracts | Optional remote configuration is not offline operation |

The claim is about **CAPTAIN's own data flow**, not all website traffic. A site can already know data you entered or an existing session cookie. Masking CAPTAIN's screenshot cannot make a logged-in website forget that information. Do not state that no sensitive data leaves the entire computer based only on extension/companion tests.

### Status of the requested 60 improvements

Numbers refer to the supplied limitations list. “Partial” and “open” must not be presented as completed capabilities in a presentation.

| Items | Status | Evidence / next required work |
| --- | --- | --- |
| 1, 17, 20, 21 | Bounded positioning | DOM supplies structure, OCR text, ONNX spatial proposals; do not describe general visual autonomy as complete |
| 2, 4, 16 | Partial; quality failing | Normal-tab visual benchmark now works and scores independent boxes; train/select a provenance-cleared model using separate training/validation/unseen-test sets |
| 3, 12, 59 | Documented and locally checked | Exact models, hashes, sizes and local runtime; license review remains open |
| 5, 14, 15, 31, 44 | Partial | Owned-tab live-navigation audit; expand to 20–50 heterogeneous tasks with independently checked outcomes, not duplicated URL opens |
| 6 | Measured, not solved universally | 24 raster OCR cases; small dark text failures remain visible; add multilingual and real-screenshot corpus before changing preprocessing |
| 7, 41 | Partial | Controlled private-kind checks and privacy regression tests exist; expand independently annotated spatial PII and mask-leakage tests |
| 8, 25, 26, 27, 28, 42, 43, 48, 54, 55, 56 | Safety boundaries retained | Fail-closed perception, stale-action guards, prompt-injection checks and human handoffs; no guarantee of perfect detection |
| 9, 10, 11, 13, 57 | Partial measurements | OCR/vision/DOM latency and isolated UI-model CPU/RSS; whole-agent peak resources and full stage breakdown still required |
| 18, 19, 50 | Open comparative evaluation | Same frozen tasks for DOM-only, CAPTAIN and an explicitly configured comparator; no fabricated superiority matrix |
| 22, 34 | Implemented / documented | Optional Ollama no longer starts by default; one-command launcher and consistent configuration parsing |
| 23, 24, 46, 47 | Boundary documented; broader proof open | Outbound contract/canary tests; add fresh scoped network capture and approved sanitized example; do not infer whole-device traffic safety |
| 29 | Partial | Action-binding and stale-target tests; independent live wrong-target/unintended-action benchmark still needed |
| 30, 49 | Implemented evidence tooling | Per-file/category test report and consolidated provenance-bound readiness report; unmeasured metrics remain explicit |
| 32, 33 | Scope corrected | Chromium MV3 on Windows; Firefox runtime not claimed |
| 35 | Open external test | Clean-machine/profile installation measurement, including required downloads |
| 36, 37, 38, 39 | Open field evaluation | Public research-portal workflow, independent outcome checks, human baseline and interaction/time measurements; no ISRO endorsement implied |
| 40 | Open comparison | Measure actual optional planner upload bytes under identical tasks; no invented cloud savings |
| 45, 51, 52, 53 | Presentation follow-up | Use existing template; show truthful public/private boundary, cited design decisions, readable links/QR and supported scope after evidence review |
| 58 | Open end-to-end validation | Packaged local models are not proof the full agent works offline; use isolated network-denied local workflow without disabling the user's network |
| 60 | Partial demo preparation | Controlled fixtures and live audit exist; rehearse exact supported workflow and retain a clearly labelled recording fallback |

No change here bypasses CAPTCHA, supplies credentials, changes the production model threshold, or promotes an unverified research model to production.

Current reliability fixes also ensure an explicit same-window tab takes precedence over an older working-tab binding. A moved/incognito explicit target is rejected, not silently replaced. The live audit checks requested login paths and checkpoints each result, so a browser/controller disconnect produces partial failure evidence instead of erasing earlier results.

### Recorded verification — 30 September 2026

These are measurements, not acceptance of the remaining quality gaps. The readiness snapshot is `runtime/readiness-runs/1747695a-d23c-48be-8800-e9c95500d95d/`; live outcomes are in `runtime/website-coverage.json`. Generated evidence stays local and must be rerun on another machine.

| Measurement | Recorded result | Scope / verdict |
| --- | --- | --- |
| Regression tests | 577/577 passed; lint passed | Software correctness checks, not website accuracy |
| Controlled DOM geometry | 40/40 cases; TP82/FP0/FN0 | Previously inspected synthetic controls |
| UI visual detector | TP3/FP1/FN40; precision 75%, recall 6.98% | 13 synthetic browser layouts; **quality failed** |
| English OCR | CER 1.90% (37/1,944); WER 6.02% (13/216) | All 24 cases ran; only 20 met per-case thresholds; **quality failed** |
| Live navigation | 8/9 completed | Wikipedia, YouTube, GitHub login, Python.org, MDN, DuckDuckGo, Netflix, Stack Overflow; Amazon failed repeated-consent stability |
| Protected credential handoff | 1/1 expected stop | GitHub sign-in blocked; no credentials entered; not a successful login |
| DOM observation p50 / p95 | 3 / 68 ms | Controlled fixture DOM processing only |
| Browser UI-model p50 / p95 | 684 / 721 ms | Fresh worker per synthetic browser case |
| OCR p50 / p95 | 998 / 1,219 ms | Fresh OCR worker, local asset verification and teardown |
| Live-check p50 / p95 | 15,066 / 52,832 ms | Ten attempts including failure and consent checkpoints; not model inference latency |
| Warm Node UI-adapter p50 / p95 | 468 / 505 ms | 12 CPU/WASM runs; synthetic raster and Node canvas adapter |
| Node benchmark CPU | Mean 105.0%; peak-per-inference 117.5% of one core | Whole Node process, including auxiliary threads; not machine-wide CPU percentage |
| Node benchmark memory | 178 MiB sampled RSS; 215.1 MiB lifetime peak RSS | Includes this benchmark's loading/verification; not total browser-agent RAM |
| Bundled model / extension bytes | 40,330,596 / 69,149,351 | Four principal model assets / generated unpacked Chrome extension |

Machine: AMD Ryzen 7 5825U, 16 logical CPUs, approximately 16 GB installed RAM, Windows x64, Node 24.19.0. The overall readiness gate is **failed**, despite passing regression and DOM tests. Amazon passed an earlier attempt but failed the repeat; Stack Overflow passed the final navigation check in about 45 seconds. Neither supports a claim of universally fast or reliable execution. No measured OCR/vision quality improvement is claimed by the tab-selection and startup fixes.

## Project structure

```text
captain/
├── applications/     Application entry points
├── benchmarks/       Evaluation fixtures and benchmark data
├── dashboard/        Local demo and diagnostic pages
├── experiments/      Isolated model and detector experiments
├── extension/        Browser extension, privacy code, and local model assets
├── libraries/        Shared TypeScript modules
├── server/           Local companion, planner, validation, and verification
├── tests/            Automated test suite and fixtures
├── tools/            Launch, audit, diagnostic, and packaging utilities
├── .env.example      Safe configuration template
├── package.json      Scripts and Node dependencies
└── README.md         Project documentation
```

## Files intentionally kept local

The repository ignores machine-specific or generated data including:

- `.env`;
- `node_modules/`;
- `runtime/`;
- `build/`;
- browser profiles and caches;
- logs and local databases.

These files can contain local state, generated artifacts, large model/runtime downloads, or credentials and should not be committed.

## Current limitations

- CAPTAIN is a prototype and is not a production security product.
- Live operation is focused on Chrome/Edge on Windows.
- Browser-protected pages, some stores, PDFs, inaccessible frames, and browser-internal URLs cannot be controlled like normal webpages.
- Sensitive-data detection cannot guarantee perfect coverage for every custom canvas, iframe, shadow DOM, language, or future website redesign.
- Highly dynamic pages can invalidate a capture or action lease; CAPTAIN stops rather than using stale or unverified context.
- CAPTCHA, anti-automation systems, account state, rate limits, and site changes can require human action.
- Protected credentials remain user-controlled and are not supplied by the agent.
- Optional local-model behavior depends on the locally installed model and hardware.

## Local-first design

CAPTAIN's main design rule is simple: the browser agent should receive only the information required to perform a task, while private values stay inside the local privacy boundary whenever possible.
