import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

test('foreground launcher provisions authentication and rejects anonymous planner calls', { timeout: 15000 }, async () => {
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const child = spawn(process.execPath, ['tools/start-server.mjs'], {
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    env: { ...process.env, CAPTAIN_PORT: String(port), CAPTAIN_HOST: '127.0.0.1', CAPTAIN_COMPANION_TOKEN: '' },
    stdio: 'ignore', windowsHide: true
  });
  const exited = once(child, 'exit');
  try {
    let ready = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(300) });
        ready = response.ok && (await response.json()).service === 'captain';
      } catch {}
      if (ready || child.exitCode !== null) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(ready, true, 'Companion must start without a manually supplied secret.');
    const response = await fetch(`http://127.0.0.1:${port}/api/agent/step`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}'
    });
    assert.equal(response.status, 401);
  } finally {
    child.kill();
    await exited;
  }
});
