import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';

async function availablePort() {
  const probe = createServer();
  await new Promise((resolve, reject) => probe.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  return port;
}

test('real localhost agent route rejects untrusted fields before its planner and metric sink retains no raw text', { timeout: 20000 }, async () => {
  const port = await availablePort();
  const host = `http://127.0.0.1:${port}`;
  const companionToken = 'a'.repeat(64);
  const extensionOrigin = `chrome-extension://${'a'.repeat(32)}`;
  // Spawn only a dedicated test child with a minimal environment. Never stop
  // a resident CAPTAIN service or use a personal browser profile.
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: new URL('..', import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:\/)/, ''),
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, CAPTAIN_PORT: String(port),
      CAPTAIN_HOST: '127.0.0.1', CAPTAIN_COMPANION_TOKEN: companionToken },
    stdio: 'ignore',
    windowsHide: true,
  });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      try { const response = await fetch(`${host}/health`); if (response.ok) { ready = true; break; } } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(ready, true, 'dedicated test service failed to start');
    const issued = await fetch(`${host}/api/companion/session`, { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-captain-auth': companionToken },
      body: JSON.stringify({ extensionOrigin }) });
    assert.equal(issued.status, 200, 'Test launcher must bind its exact extension origin.');
    const { token: sessionToken, expiresAt } = await issued.json();
    assert.match(sessionToken, /^[a-f0-9]{64}$/);
    assert.notEqual(sessionToken, companionToken, 'Durable bootstrap secret must not become a browser credential.');
    assert.ok(expiresAt > Date.now());
    async function send(route, value) {
      const response = await fetch(`${host}${route}`, {
        method: 'POST', headers: { 'content-type': 'application/json',
          origin: extensionOrigin, 'x-captain-auth': sessionToken },
        body: JSON.stringify(value),
      });
      return { status: response.status, body: await response.json() };
    }
    const safe = { task: 'open YouTube', context: { url: 'about:blank', title: 'New browser tab', elements: [] }, history: [] };
    for (const headers of [
      { 'content-type': 'application/json', origin: extensionOrigin },
      { 'content-type': 'application/json', origin: extensionOrigin, 'x-captain-auth': 'b'.repeat(64) },
      { 'content-type': 'application/json', origin: extensionOrigin, 'x-captain-auth': 'malformed' },
      { 'content-type': 'application/json', origin: extensionOrigin, 'x-captain-auth': companionToken },
      { 'content-type': 'application/json', 'x-captain-auth': sessionToken },
    ]) {
      const denied = await fetch(`${host}/api/agent/step`, { method: 'POST', headers, body: JSON.stringify(safe) });
      assert.equal(denied.status, 401);
      assert.equal((await denied.json()).code, 'CAPTAIN_COMPANION_AUTH');
    }
    const wrongOrigin = await fetch(`${host}/api/agent/step`, { method: 'POST',
      headers: { 'content-type': 'application/json', origin: `chrome-extension://${'b'.repeat(32)}`,
        'x-captain-auth': sessionToken }, body: JSON.stringify(safe) });
    assert.equal(wrongOrigin.status, 403);
    const accepted = await send('/api/agent/step', safe);
    assert.equal(accepted.status, 200);
    assert.ok(accepted.body.action);
    for (const unsafe of [
      { ...safe, unrecognized: 'private-canary' },
      { ...safe, task: 'CANARY_PRIVATE_DATA' },
      { ...safe, context: { ...safe.context, url: 'https://example.test/?token=private' } },
      { ...safe, context: { ...safe.context, screenshot: 'data:image/jpeg;base64,/9j/AA==' } },
    ]) {
      const rejected = await send('/api/agent/step', unsafe);
      assert.equal(rejected.status, 422);
      assert.doesNotMatch(JSON.stringify(rejected.body), /private-canary|CANARY_PRIVATE_DATA|token=private/);
    }
    const imageBytes = Buffer.alloc(120, 7);
    imageBytes[0] = 0xff; imageBytes[1] = 0xd8; imageBytes[2] = 0xff;
    imageBytes[118] = 0xff; imageBytes[119] = 0xd9;
    const imageSha256 = createHash('sha256').update(imageBytes).digest('hex');
    const visualPrivacy = {
      schema: 'captain.visual-privacy.v2', sanitized: true,
      rawScreenshotTransmitted: false, redactionApplied: true,
      domBoxes: 1, faces: 1, inferenceMs: 10, totalMs: 20,
      outputBytes: imageBytes.length, faceModel: 'ultraface-rfb-320',
      modelSha256: 'd7c687949526065ab6a192fdf993360045ce27b0fabf7c9fca5c2437b786b495',
      imageSha256,
      maskPolicy: 'opaque-raster-v1', coverageVerified: true, pixelMaskCount: 2,
      input: { width: 640, height: 480 },
    };
    const provenImage = {
      ...safe,
      context: {
        ...safe.context,
        screenshot: `data:image/jpeg;base64,${imageBytes.toString('base64')}`,
        visualPrivacy,
      },
    };
    const acceptedImage = await send('/api/agent/step', provenImage);
    assert.equal(acceptedImage.status, 200, 'v2-proven image must pass the real HTTP boundary');
    assert.ok(acceptedImage.body.action);
    const audit = await (await fetch(`${host}/api/metrics`)).json();
    assert.equal(audit.lastVisualAudit.schema, 'captain.visual-privacy.v2');
    assert.equal(audit.lastVisualAudit.rawScreenshotReceived, false);
    assert.equal(audit.lastVisualAudit.imageSha256, imageSha256);
    const rejectedImage = await send('/api/agent/step', {
      ...provenImage, context: {
        ...provenImage.context,
        visualPrivacy: { ...visualPrivacy, imageSha256: '0'.repeat(64) },
      },
    });
    assert.equal(rejectedImage.status, 422);
    assert.equal(rejectedImage.body.code, 'CAPTAIN_OUTBOUND_CONTRACT');
    assert.doesNotMatch(JSON.stringify(rejectedImage.body), /data:image|base64/);
    const telemetry = await send('/api/metrics', { latencyMs: 100, task: 'private-canary' });
    assert.equal(telemetry.status, 422); // Reject; fixed server error body never mirrors raw metrics.
    assert.doesNotMatch(JSON.stringify(telemetry.body), /private-canary/);
    const sample = await send('/api/metrics', { latencyMs: 100, piiDetected: 0, steps: 1 });
    assert.equal(sample.status, 202);
    const metrics = await (await fetch(`${host}/api/metrics`)).json();
    assert.equal(metrics.runs, 1);
    assert.doesNotMatch(JSON.stringify(metrics), /private-canary/);
    const rotated = await fetch(`${host}/api/companion/session`, { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-captain-auth': companionToken },
      body: JSON.stringify({ extensionOrigin }) });
    assert.equal(rotated.status, 200);
    assert.notEqual((await rotated.json()).token, sessionToken);
    assert.equal((await send('/api/agent/step', safe)).status, 401,
      'Previous session credential must expire immediately on rotation.');
  } finally {
    child.kill();
    await new Promise(resolve => { if (child.exitCode != null || child.signalCode != null) resolve(); else child.once('exit', resolve); });
  }
});
