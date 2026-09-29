import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));

test('original Phase-9 handoff builds and checks exact source and browser ZIP payloads', { timeout: 300_000 }, async () => {
  const command = spawnSync(process.execPath, ['tools/package-phase-09.mjs'],
    { cwd: root, windowsHide: true, encoding: 'utf8', timeout: 270_000, maxBuffer: 1024 * 1024 });
  assert.equal(command.error, undefined, 'Release packaging must not time out.');
  assert.equal(command.status, 0, 'Release ZIP byte/asset inspection must pass.');
  const last = command.stdout.trim().split(/\r?\n/).at(-1);
  const result = JSON.parse(last);
  assert.equal(result.sourceManifestVerified, true);
  assert.equal(result.extensionZipContentsVerified, true);
  assert.ok(result.sourceFiles >= 100);
  const directory = join(root, 'build', 'release');
  const sums = (await readFile(join(directory, 'SHA256SUMS.txt'), 'utf8')).trim().split(/\r?\n/);
  assert.equal(sums.length, 3);
  assert.ok(sums.some(x => x.endsWith('captain-sih26171-source.zip')));
  assert.ok(sums.some(x => x.endsWith('captain-chrome.zip')));
  assert.ok(sums.some(x => x.endsWith('captain-firefox.zip')));
  const manifest = JSON.parse(await readFile(join(root,'build','source','RELEASE-MANIFEST.json'), 'utf8'));
  assert.equal(manifest.researchCandidateShipped, false);
  assert.equal(manifest.productionUiModel.qualityAccepted, false);
  assert.ok(manifest.sourceFiles.every(x => x.path === '.env.example' ||
    !/(?:^|\/)(?:runtime|research|node_modules|profiles?)(?:\/|$)|(?:^|\/)\.env(?:\.|$)/i.test(x.path)));
  assert.ok(manifest.sourceFiles.some(x => x.path === '.env.example'));
  for (const required of ['README.md', 'extension/entities/ATTRIBUTION.txt',
    'extension/controls/ATTRIBUTION.txt'])
    assert.ok(manifest.sourceFiles.some(x => x.path === required), 'Missing canonical handoff: ' + required);
  assert.deepEqual(manifest.sourceFiles.filter(x => /\.(md|mdx|rst)$/i.test(x.path)).map(x => x.path), ['README.md']);
  assert.ok(manifest.sourceFiles.every(x => !x.path.startsWith('handoffs/') &&
    !/^START-PHASE-\d+\.txt$/i.test(x.path)));
});

test('judge instructions expose nonpassing quality and user approval requirements', async () => {
  const docs = await readFile(join(root,'README.md'),'utf8');
  for (const phrase of ['TP0/FP0/FN43', '0/5', 'SHA-256', 'normal tabs', 'Firefox'])
    assert.ok(docs.includes(phrase), 'Missing truthful handoff evidence: ' + phrase);
  assert.match(docs, /(?:approval|approved)/i);
  assert.match(docs, /research.*(?:excluded|not production)/is);
});

test('Phase-9 local dashboard reports negative model and selective evidence without source pixels', async () => {
  const page = await readFile(join(root,'dashboard/phase-09-audit.html'),'utf8');
  const server = await readFile(join(root,'server/index.mjs'),'utf8');
  for (const phrase of ['TP0', 'FN43', '0 / 5', '145,999 ms', 'NOT PUBLIC-RELEASE READY'])
    assert.ok(page.includes(phrase), 'Missing release-risk metric: ' + phrase);
  assert.ok(server.includes('dashboard/phase-09-audit.html'), 'Local static route absent.');
  assert.doesNotMatch(page, /<img\b|fetch\s*\(|<script\b/i, 'The static numeric board must not load private images or network script.');
});

test('private-form acceptance uses an exact synthetic tab and a delivered focus-enabled browser gesture', async () => {
  const script = await readFile(join(root,'tools/phase-07-private-form.mjs'),'utf8');
  assert.match(script,/chrome\.debugger\.getTargets\(\)/);
  assert.match(script,/Emulation\.setFocusEmulationEnabled/);
  assert.match(script,/Input\.dispatchMouseEvent/);
  assert.match(script,/gestureCounts\.down\s*&&\s*gestureCounts\.up\s*&&\s*gestureCounts\.click/);
  assert.doesNotMatch(script,/functionDeclaration:[^\n]*this\.click\(\)/,
    'Untrusted synthetic element activation cannot substitute for local consent.');
  assert.equal((script.match(/Accessibility\.getFullAXTree/g) || []).length,1,
    'Do not retrieve the private input accessibility value after synthetic entry.');
});
