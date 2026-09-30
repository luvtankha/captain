import http from "node:http";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { payloadLeaks } from "./privacy.mjs";
import { sanitizeMetricSample, sanitizeVisualAudit } from "./metrics.mjs";
import { assertSafeToTransmit, sanitizeObservation } from "./outbound-contract.mjs";
import { planStep } from "./planner.mjs";
import { expectedServerRuntime } from "../tools/server-runtime.mjs";
import {
  allowedOrigin,
  createRateLimiter,
  issueCompanionSession,
  isJsonRequest,
  responseOrigin,
  validCompanionSession,
  validCompanionToken,
} from "./security.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const runtime = expectedServerRuntime(root);
let activeRequests = 0;
try {
  for (const [name, value] of Object.entries(parseEnv(readFileSync(join(root, ".env"), "utf8")))) {
    if (process.env[name] === undefined) process.env[name] = value;
  }
} catch {}
const port = Number(process.env.CAPTAIN_PORT || 4317);
const host = process.env.CAPTAIN_HOST || "127.0.0.1";
// The companion handles sanitized browser observations and must not become a
// LAN-facing service through an inherited environment or copied .env file.
if (host !== "127.0.0.1")
  throw new Error("CAPTAIN companion must bind only to 127.0.0.1.");
const companionToken = process.env.CAPTAIN_COMPANION_TOKEN || "";
if (!/^[a-f0-9]{64}$/.test(companionToken))
  throw new Error("CAPTAIN companion authentication is unavailable. Start CAPTAIN with the project launcher.");
const samples = [];
let browserSession = null;
let lastVisualAudit = null;
const checkAgentRate = createRateLimiter({ limit: 60, windowMs: 60_000 });
const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css",
  ".js": "text/javascript",
  ".json": "application/json",
  ".jpg": "image/jpeg",
};

function json(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}

// Schema failures have no user values in their generated path/reason, but do
// have enough fixed structure to diagnose a local extension/server mismatch.
// Keep the response deliberately allowlisted: never reflect arbitrary error
// strings, request content, URLs, screenshots, OCR, or page text.
function safeContractDiagnostic(error) {
  const match = /^Outbound contract rejected ([A-Za-z0-9_.\[\]]{1,160}): ([a-z-]{2,40}(?: [a-z-]{2,40}){0,4})$/.exec(String(error?.message || ''));
  if (!match) return null;
  const [, path, reason] = match;
  const allowedReasons = new Set([
    'invalid field', 'expected plain object', 'unexpected field', 'accessor field',
    'undefined field', 'missing required field', 'invalid array size', 'sparse array',
    'unexpected array property', 'unexpected value', 'out-of-range number',
    'expected boolean', 'unsafe or oversized text', 'invalid digest', 'invalid fingerprint',
    'invalid URL', 'unsafe URL', 'invalid URL encoding', 'invalid element reference',
    'invalid product identifier', 'unknown counter', 'sensitive value not redacted',
    'sensitive options not redacted', 'missing proof', 'unknown proof schema',
    'invalid JPEG data URL', 'invalid JPEG bitstream', 'unverified pixel mask coverage',
    'proof integrity mismatch', 'orphan visual proof', 'missing visual proof',
    'legacy proof requires migration', 'proof provenance mismatch',
    'privacy status mismatch', 'privacy review or blocked', 'payload too large'
  ]);
  return allowedReasons.has(reason) ? { contractPath: path, contractReason: reason } : null;
}

async function body(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (Buffer.byteLength(raw) > 4_500_000) {
      const error = new Error("Request too large");
      error.status = 413;
      throw error;
    }
  }
  return JSON.parse(raw || "{}");
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  res.setHeader("access-control-allow-origin", responseOrigin(origin, browserSession?.origin));
  res.setHeader("access-control-allow-headers", "content-type, x-captain-auth");
  res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  res.setHeader("vary", "Origin");
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("referrer-policy", "no-referrer");
  if (!allowedOrigin(origin, browserSession?.origin))
    return json(res, 403, { error: "Origin is not permitted" });
  if (req.method === "OPTIONS") return json(res, 204, {});
  const url = new URL(req.url, `http://${req.headers.host}`);
  // Only the local launcher holding the durable bootstrap secret can bind
  // this companion to the exact installed extension origin. Issuance rotates
  // the previous short-lived browser token; neither token is logged.
  if (url.pathname === "/api/companion/session" && req.method === "POST") {
    if (origin || !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress || "") ||
        !validCompanionToken(req.headers, companionToken))
      return json(res, 401, { error: "CAPTAIN session issuance denied", code: "CAPTAIN_COMPANION_AUTH" });
    if (!isJsonRequest(req.headers))
      return json(res, 415, { error: "application/json is required" });
    if (activeRequests) return json(res, 409, { error: "Active task prevents session rotation" });
    let input;
    try { input = await body(req); }
    catch { return json(res, 422, { error: "Invalid session request" }); }
    if (!input || typeof input !== "object" || Array.isArray(input) ||
        Object.keys(input).length !== 1 || typeof input.extensionOrigin !== "string" ||
        !/^chrome-extension:\/\/[a-p]{32}$/.test(input.extensionOrigin))
      return json(res, 422, { error: "Invalid extension session origin" });
    browserSession = issueCompanionSession(input.extensionOrigin);
    return json(res, 200, { token: browserSession.token, expiresAt: browserSession.expiresAt });
  }
  const protectedRequest =
    (url.pathname === "/api/agent/step" && req.method === "POST") ||
    (url.pathname === "/api/metrics" && req.method === "POST");
  if (protectedRequest && !validCompanionSession(req.headers, browserSession))
    return json(res, 401, { error: "CAPTAIN companion authentication required", code: "CAPTAIN_COMPANION_AUTH" });
  try {
    if (url.pathname === "/health")
      return json(res, 200, {
        ok: true,
        service: "captain",
        authRequired: true,
        ...runtime,
        activeRequests,
        planner: process.env.CAPTAIN_OLLAMA_MODEL
          ? "ollama"
          : process.env.CAPTAIN_VLM_API_KEY
            ? "vlm"
            : "local-fallback",
        model: process.env.CAPTAIN_OLLAMA_MODEL || null,
      });
    if (url.pathname === "/api/metrics" && req.method === "GET") {
      const average = (key) =>
        samples.length
          ? Math.round(
              samples.reduce((sum, x) => sum + Number(x[key] || 0), 0) /
                samples.length,
            )
          : 0;
      return json(res, 200, {
        runs: samples.length,
        latencyMs: average("latencyMs"),
        piiDetected: samples.reduce(
          (n, x) => n + Number(x.piiDetected || 0),
          0,
        ),
        last: samples.at(-1) || null,
        lastVisualAudit,
      });
    }
    if (url.pathname === "/api/metrics" && req.method === "POST") {
      if (!isJsonRequest(req.headers))
        return json(res, 415, { error: "application/json is required" });
      let sample;
      try {
        sample = sanitizeMetricSample(await body(req));
      } catch {
        return json(res, 422, { error: "Telemetry contract rejected unsafe or unsupported metrics", code: "CAPTAIN_TELEMETRY_CONTRACT" });
      }
      samples.push(sample);
      samples.splice(0, Math.max(0, samples.length - 100));
      return json(res, 202, { ok: true });
    }
    if (url.pathname === "/api/benchmark" && req.method === "GET") {
      const report = JSON.parse(
        await readFile(join(root, "runtime", "benchmark-results.json"), "utf8"),
      );
      return json(res, 200, report);
    }
    if (url.pathname === "/api/amazon-latency" && req.method === "GET") {
      const [benchmark, baseline, optimized] = await Promise.all([
        readFile(join(root, "runtime", "amazon-latency-benchmark.json"), "utf8").then(JSON.parse),
        readFile(join(root, "runtime", "amazon-latency-baseline.json"), "utf8").then(JSON.parse),
        readFile(join(root, "runtime", "amazon-latency-optimized.json"), "utf8").then(JSON.parse),
      ]);
      return json(res, 200, { benchmark, baseline, optimized });
    }
    if (url.pathname === "/api/acceptance" && req.method === "GET") {
      const report = JSON.parse(
        await readFile(
          join(root, "runtime", "acceptance-summary.json"),
          "utf8",
        ),
      );
      return json(res, 200, report);
    }
    if (url.pathname === "/api/handoff" && req.method === "GET") {
      const report = JSON.parse(
        await readFile(join(root, "runtime", "handoff-audit.json"), "utf8"),
      );
      return json(res, 200, report);
    }
    if (
      url.pathname === "/api/benchmark/sanitized-image" &&
      req.method === "GET"
    ) {
      const file = await readFile(
        join(root, "runtime", "sanitized-privacy-audit.jpg"),
      );
      res.writeHead(200, {
        "content-type": "image/jpeg",
        "cache-control": "no-store",
      });
      return res.end(file);
    }
    if (url.pathname === "/api/agent/step" && req.method === "POST") {
      if (!isJsonRequest(req.headers))
        return json(res, 415, { error: "application/json is required" });
      const rate = checkAgentRate(
        `${req.socket.remoteAddress || "local"}:${origin || "no-origin"}`,
      );
      res.setHeader("x-ratelimit-remaining", String(rate.remaining));
      if (!rate.allowed) {
        res.setHeader(
          "retry-after",
          String(Math.ceil(rate.retryAfterMs / 1000)),
        );
        return json(res, 429, { error: "Too many agent requests" });
      }
      const started = performance.now();
      const input = await body(req);
      const bodyParsed = performance.now();
      if (!input?.task || !input?.context)
        return json(res, 400, { error: "task and context are required" });
      // Mandatory fail-closed, allowlisted projection: even a locally redacted
      // transport can contain unexpected keys or an expired/mismatched proof.
      // Never pass the original parsed object to the planner or external model.
      let safeInput;
      try {
        safeInput = assertSafeToTransmit(sanitizeObservation(input));
      } catch (error) {
        return json(res, 422, {
          error: "Outbound contract rejected unsafe or unsupported context",
          code: "CAPTAIN_OUTBOUND_CONTRACT",
          ...(safeContractDiagnostic(error) || {}),
        });
      }
      // The legacy text scanner understands v1 image proofs only. Both v1
      // and v2 image bytes, model identity and digests were already checked
      // by the strict contract above. Scan only its validated text/history
      // when an image is present, so valid v2 proofs are not misclassified as
      // unverified images or numeric identifiers inside SHA-256 digests.
      const leakScanInput = safeInput.context.screenshot
        ? {
            task: safeInput.task,
            context: {
              ...safeInput.context,
              screenshot: undefined,
              visualPrivacy: undefined,
              screenshotMetadata: undefined,
              pageMetadata: undefined,
            },
            history: safeInput.history,
          }
        : input;
      const leaks = payloadLeaks(leakScanInput);
      const privacyChecked = performance.now();
      if (leaks.length)
        return json(res, 422, {
          error: "Privacy boundary rejected unsanitized PII",
          categories: [...new Set(leaks.map((x) => x.kind))],
        });
      lastVisualAudit = safeInput.context.screenshot
        ? {
            ...sanitizeVisualAudit(safeInput.context.visualPrivacy),
            schema: safeInput.context.visualPrivacy.schema,
          }
        : {
            receivedAt: new Date().toISOString(),
            screenshotField: "none",
            rawScreenshotReceived: false,
          };
      activeRequests++;
      try {
        const plannerStarted = performance.now();
        const plan = await planStep(
          safeInput.task,
          safeInput.context,
          safeInput.history,
        );
        return json(res, 200, {
          ...plan,
          serverLatencyMs: Math.round(performance.now() - started),
          serverTiming: { bodyParseMs: Math.round(bodyParsed - started), privacyBoundaryMs: Math.round(privacyChecked - bodyParsed), plannerMs: Math.round(performance.now() - plannerStarted) },
        });
      } finally {
        activeRequests--;
      }
    }
    const dashboardRoutes = new Map([
      ["/", "dashboard/index.html"],
      ["/demo.html", "dashboard/demo.html"],
      ["/privacy-fixture.html", "dashboard/privacy-fixture.html"],
      ["/challenge-fixture.html", "dashboard/challenge-fixture.html"],
      ["/benchmark.html", "dashboard/benchmark.html"],
      ["/visual-fixture.html", "dashboard/visual-fixture.html"],
      ["/phase-08-heldout.html", "dashboard/phase-08-heldout.html"],
      ["/phase-09-audit.html", "dashboard/phase-09-audit.html"],
      ["/ultraface-test.jpg", "dashboard/ultraface-test.jpg"],
    ]);
    const relative =
      dashboardRoutes.get(url.pathname) || url.pathname.replace(/^\//, "");
    if (relative.includes(".."))
      return json(res, 400, { error: "Invalid path" });
    if (
      ![
        "dashboard/index.html",
        "dashboard/demo.html",
        "dashboard/privacy-fixture.html",
        "dashboard/challenge-fixture.html",
        "dashboard/benchmark.html",
        "dashboard/visual-fixture.html",
        "dashboard/phase-08-heldout.html",
        "dashboard/phase-09-audit.html",
        "dashboard/ultraface-test.jpg",
        "dashboard/style.css",
        "dashboard/app.js",
      ].includes(relative)
    )
      return json(res, 404, { error: "Not found" });
    const file = await readFile(join(root, relative));
    res.setHeader(
      "content-security-policy",
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'",
    );
    res.writeHead(200, {
      "content-type": types[extname(relative)] || "application/octet-stream",
    });
    res.end(file);
  } catch (error) {
    if (error.code === "ENOENT") return json(res, 404, { error: "Not found" });
    // Fixed operational code for the authenticated local planner path. Never
    // echo provider text, JSON output, page values, tokens or exception bodies.
    if (url.pathname === "/api/agent/step" && req.method === "POST" &&
        !(Number(error.status) && error.status < 500)) {
      const message = String(error?.message || "");
      const code = message === "Ollama returned no structured action." ? "MODEL_EMPTY" :
        /Unexpected token|JSON/.test(message) ? "MODEL_JSON_INVALID" :
        /invalid action|observed page control|control that is not on this page/i.test(message) ? "MODEL_ACTION_INVALID" :
        /aborted|timeout|timed out/i.test(message) ? "MODEL_TIMEOUT" :
        /Ollama unavailable/.test(message) ? "MODEL_UNAVAILABLE" : "PLANNER_FAILED";
      const providerStatus = code === "MODEL_UNAVAILABLE" ?
        Number(message.match(/^Ollama unavailable \(([1-5][0-9]{2})[;)]/)?.[1]) : null;
      const providerKind = code === "MODEL_UNAVAILABLE" ?
        message.match(/^Ollama unavailable \([1-5][0-9]{2}; (memory|context|image|request|model|unknown)\)/)?.[1] : null;
      return json(res, 500, { error: "Request could not be processed", code,
        ...(providerStatus ? { providerStatus } : {}),
        ...(providerKind ? { providerKind } : {}) });
    }
    json(res, Number(error.status) || 500, {
      error:
        Number(error.status) && error.status < 500
          ? error.message
          : "Request could not be processed",
    });
  }
});

server.listen(port, host, () =>
  console.log(`CAPTAIN control plane: http://${host}:${port}`),
);
