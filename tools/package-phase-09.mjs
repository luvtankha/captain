// Original master-plan Phase 9: local-only, explicit-allowlist source and extension handoff.
// Never package the workspace wholesale. Release artifacts remain local until approved.
import assert from 'node:assert/strict';
import { zipDirectory } from './archive.mjs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFile, lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const dist = join(root, 'build');
const stage = join(dist, 'source');
const release = join(dist, 'release');
const sourceZip = join(release, 'captain-sih26171-source.zip');
const rootFiles = [
  '.env.example', '.gitignore', 'README.md', 'START-CAPTAIN.cmd',
  'Dockerfile', 'docker-compose.yml', 'package.json', 'package-lock.json',
  'tsconfig.json'
];
const sourceDirectories = [
  'applications', 'benchmarks', 'dashboard', 'extension',
  'libraries', 'tools', 'server', 'tests'
];
const forbiddenSegment = /^(?:\.git|\.svn|node_modules|dist|build|runtime|research|experiments|__pycache__|\.cache|cache|caches|profiles?|user[ -]?data|captures?|screenshots?|downloads)$/i;
const forbiddenFile = /(?:^\.env(?:\..*)?$|\.(?:pem|key|p12|pfx|sqlite|db|log|trace|zip|7z|tar|gz\.tar|pt|pth|safetensors|gguf)$)/i;
const allowedModels = new Set([
  'extension/faces/ultraface-rfb-320.onnx',
  'extension/controls/model.onnx',
  'extension/entities/model.quant.onnx'
]);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const unix = path => path.split(sep).join('/');

function allowed(rel) {
  const normalized = unix(rel);
  if (normalized === '.env.example') return true; // inert, reviewed template only
  const segments = normalized.split('/');
  if (segments.some(segment => forbiddenSegment.test(segment))) return false;
  const name = segments.at(-1);
  if (forbiddenFile.test(name)) return false;
  if (/\.(?:onnx|bin)$/i.test(name) && !allowedModels.has(normalized)) return false;
  // Screenshot/source-image rights have not been independently reviewed.
  if (/\.(?:png|jpe?g|webp|gif|bmp)$/i.test(name) &&
      !normalized.startsWith('extension/icons/')) return false;
  if (/^extension\/vendor\/ort-wasm-simd-threaded\.jsep\./.test(normalized)) return false;
  return true;
}
function verifyWorkspacePath(target, expected) {
  assert.equal(resolve(target), resolve(join(root, expected)), 'Unreviewed deletion target.');
  assert.ok(!relative(root, target).startsWith('..'), 'Outside workspace.');
}
async function copyReviewed(source, target, rel, inventory) {
  const meta = await lstat(source);
  assert.equal(meta.isSymbolicLink(), false, 'Symlink refused: ' + rel);
  if (meta.isDirectory()) {
    await mkdir(target, { recursive: true });
    for (const name of (await readdir(source)).sort()) {
      const child = rel ? rel + '/' + name : name;
      if (allowed(child)) await copyReviewed(join(source, name), join(target, name), child, inventory);
    }
    return;
  }
  assert.equal(meta.isFile(), true, 'Non-regular source refused: ' + rel);
  if (!allowed(rel)) return;
  await mkdir(resolve(target, '..'), { recursive: true });
  const bytes = await readFile(source);
  await copyFile(source, target);
  inventory.push({ path: rel, size: bytes.length, sha256: hash(bytes) });
}
function psQuoted(path) { return "'" + path.replaceAll("'", "''") + "'"; }
function archiveEntries(archive) {
  const cmd = 'Add-Type -AssemblyName System.IO.Compression.FileSystem; ' +
    '$z=[System.IO.Compression.ZipFile]::OpenRead(' + psQuoted(archive) + '); ' +
    'try { @($z.Entries | ForEach-Object { $_.FullName }) | ConvertTo-Json -Compress } finally { $z.Dispose() }';
  const output = execFileSync('powershell', ['-NoProfile','-Command', cmd],
    { cwd: root, windowsHide: true, encoding: 'utf8' }).trim();
  const parsed = JSON.parse(output || '[]');
  return (Array.isArray(parsed) ? parsed : [parsed])
    .map(x => x.replaceAll('\\', '/').replace(/^source\//, ''))
    .filter(x => x && !x.endsWith('/'));
}
function archiveHashes(archive) {
  const cmd = 'Add-Type -AssemblyName System.IO.Compression.FileSystem; ' +
    '$z=[System.IO.Compression.ZipFile]::OpenRead(' + psQuoted(archive) + '); ' +
    '$sha=[System.Security.Cryptography.SHA256]::Create(); ' +
    'try { @($z.Entries | Where-Object { -not $_.FullName.EndsWith([char]92) -and -not $_.FullName.EndsWith(\'/\') } | ForEach-Object { ' +
    '$s=$_.Open(); try { [pscustomobject]@{ name=$_.FullName; hash=([System.BitConverter]::ToString($sha.ComputeHash($s))).Replace(\'-\',\'\').ToLowerInvariant() } } finally { $s.Dispose() } ' +
    '}) | ConvertTo-Json -Compress } finally { $sha.Dispose(); $z.Dispose() }';
  const output = execFileSync('powershell', ['-NoProfile','-Command',cmd],
    { cwd: root, windowsHide: true, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }).trim();
  const parsed = JSON.parse(output || '[]');
  return new Map((Array.isArray(parsed) ? parsed : [parsed]).map(({name,hash}) =>
    [name.replaceAll('\\','/').replace(/^source\//,''),hash]));
}

verifyWorkspacePath(stage, 'build/source');
verifyWorkspacePath(release, 'build/release');
// Original package script enforces the exact pinned model hashes and licenses.
execFileSync(process.execPath, [join(root, 'tools/package.mjs')],
  { cwd: root, windowsHide: true, stdio: 'inherit' });
await rm(stage, { recursive: true, force: true });
await rm(release, { recursive: true, force: true });
await mkdir(stage, { recursive: true });
await mkdir(release, { recursive: true });
const inventory = [];
for (const name of rootFiles) await copyReviewed(join(root, name), join(stage, name), name, inventory);
for (const name of sourceDirectories)
  await copyReviewed(join(root, name), join(stage, name), name, inventory);
inventory.sort((a,b) => a.path.localeCompare(b.path));
const manifest = {
  schema: 'captain.phase-09.clean-source.v1',
  status: 'SIH prototype; NOT approved for public release',
  scope: 'Allowlisted source, necessary local assets, fixtures, tests and licenses; no runtime evidence or secrets',
  sourceFiles: inventory,
  excluded: ['.env', '.git', 'node_modules', 'runtime', 'build', 'experiments',
    'extension/controls/research', 'uncleared screenshots', 'browser profiles'],
  productionUiModel: { sha256: 'd29b6210d171e3dc5454e09847aaabce6a0255eaefa565b639e1301a9e933ef9',
    qualityAccepted: false, license: 'AGPL-3.0-derived; retain complete notice/source card' },
  researchCandidateShipped: false
};
await writeFile(join(stage, 'RELEASE-MANIFEST.json'), JSON.stringify(manifest, null, 2) + '\n');
await zipDirectory(stage, sourceZip, { prefix: 'source' });
const expected = [...inventory.map(x=>x.path), 'RELEASE-MANIFEST.json'].sort();
const actual = archiveEntries(sourceZip).sort();
assert.deepEqual(actual, expected, 'ZIP file list differs from reviewed source stage.');
const zippedSource = archiveHashes(sourceZip);
for (const entry of inventory)
  assert.equal(zippedSource.get(entry.path), entry.sha256, 'ZIP content/hash mismatch: ' + entry.path);
assert.equal(zippedSource.get('RELEASE-MANIFEST.json'),
  hash(await readFile(join(stage, 'RELEASE-MANIFEST.json'))), 'Manifest payload mismatch.');
for (const name of actual) {
  assert.ok(allowed(name), 'Prohibited source archive entry: ' + name);
  assert.ok(!name.startsWith('/') && !name.includes('..'), 'Unsafe archive entry: ' + name);
}
for (const name of [
  'package-lock.json', '.env.example', 'README.md',
  'tools/package.mjs',
  'tools/phase-08-evaluate.mjs', 'benchmarks/groundTruth.json',
  'dashboard/privacy-fixture.html', 'dashboard/phase-08-heldout.html',
  'dashboard/phase-09-audit.html', 'benchmarks/phase-08-corpus.json',
  'extension/controls/YOLOV5-AGPL-3.0-LICENSE.txt',
  'extension/controls/ATTRIBUTION.txt', 'extension/text/NOTICE.txt',
  'extension/entities/APACHE-2.0-LICENSE.txt'
]) assert.ok(actual.includes(name), 'Required reproducibility/license file absent: ' + name);
assert.ok(!actual.some(name => name.startsWith('handoffs/') ||
  /^START-PHASE-\d+\.txt$/i.test(name)), 'Obsolete phase handoff leaked into release.');
for (const name of ['captain-chrome.zip', 'captain-firefox.zip']) {
  const src = join(dist, name);
  const dst = join(release, name);
  await copyFile(src, dst);
  const entries = archiveEntries(dst);
  assert.ok(entries.includes('manifest.json'), 'Missing browser extension manifest.');
  assert.ok(entries.includes('controls/YOLOV5-AGPL-3.0-LICENSE.txt'), 'Missing AGPL notice.');
  assert.ok(entries.includes('controls/model.onnx'), 'Missing production UI model.');
  assert.ok(entries.includes('text/NOTICE.txt'), 'Missing OCR notices.');
  assert.ok(entries.includes('entities/APACHE-2.0-LICENSE.txt'), 'Missing alternative model license.');
  assert.ok(!entries.some(x => /(?:^|\/)(?:research|experiments|node_modules|runtime|profiles?)(?:\/|$)|phase-06-live|ui-shape|\.env|\.pt$/i.test(x)),
    'Unreviewed research, diagnostic, or private content in browser ZIP.');
  const zipped = archiveHashes(dst);
  // Independently compare every browser ZIP member, not only the three models.
  // Firefox's transformed manifest is compared to its own generated stage.
  const browserStage = join(dist, name.replace(/^captain-/, '').replace(/\.zip$/, ''));
  const expectedEntries = [];
  async function verifyBrowserDirectory(directory, prefix = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = prefix ? prefix + '/' + entry.name : entry.name;
      if (entry.isDirectory()) await verifyBrowserDirectory(join(directory, entry.name), path);
      else {
        assert.ok(entry.isFile() && !entry.isSymbolicLink(), 'Non-regular browser asset.');
        expectedEntries.push(path);
        assert.equal(zipped.get(path), hash(await readFile(join(directory, entry.name))),
          'Browser ZIP content mismatch: ' + path);
      }
    }
  }
  await verifyBrowserDirectory(browserStage);
  assert.deepEqual(entries.sort(), expectedEntries.sort(), 'Unexpected or missing browser ZIP entry.');
  for (const [asset, expectedHash] of [
    ['faces/ultraface-rfb-320.onnx','d7c687949526065ab6a192fdf993360045ce27b0fabf7c9fca5c2437b786b495'],
    ['controls/model.onnx','d29b6210d171e3dc5454e09847aaabce6a0255eaefa565b639e1301a9e933ef9'],
    ['entities/model.quant.onnx','b227845ff4989c9f7383874b841895dfbdb9a4d7a20ceb39c3f187271894bf2a']
  ]) assert.equal(zipped.get(asset), expectedHash, 'Release ZIP model payload mismatch: ' + asset);
}
const artifacts = ['captain-sih26171-source.zip','captain-chrome.zip','captain-firefox.zip'];
const sumLines = [];
for (const name of artifacts)
  sumLines.push(hash(await readFile(join(release,name))) + '  ' + name);
await writeFile(join(release,'SHA256SUMS.txt'), sumLines.join('\n') + '\n');
await writeFile(join(release,'RELEASE-NOTICE.txt'),
  'CAPTAIN SIH26171 — local, reviewable SIH prototype only. NOT approved for public release.\n' +
  'Read the single root README.md in the source ZIP.\n' +
  'Pinned UI detector TP0/FP0/FN43 on the 13 synthetic private-browser cases.\n' +
  'Larger selective preservation 0/5; research candidate unverified and excluded.\n' +
  'Firefox static-only; no store approval or fresh-machine proof. External publishing needs owner approval.\n');
console.log(JSON.stringify({sourceFiles:inventory.length,sourceZip,release,
  artifacts:sumLines,sourceManifestVerified:true,extensionZipContentsVerified:true}));
