# CAPTAIN

CAPTAIN is a privacy-first browser agent that runs as a Manifest V3 browser extension with a local companion service. It accepts user commands, observes the active webpage locally, detects sensitive information before planning, redacts protected regions, asks for consent when required, and executes only validated browser actions.

The project is designed so raw sensitive values and unverified screenshots do not need to leave the browser privacy boundary.

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
