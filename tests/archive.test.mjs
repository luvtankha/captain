import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, utimes, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { zipDirectory } from '../tools/archive.mjs';

test('release ZIP bytes do not depend on timestamps and retain UTF-8 file contents', async () => {
  const root = await mkdtemp(join(tmpdir(), 'captain-archive-'));
  try {
    const source = join(root, 'source');
    await mkdir(source);
    await writeFile(join(source, 'café.txt'), 'synthetic payload');
    await zipDirectory(source, join(root, 'a.zip'));
    await utimes(join(source, 'café.txt'), new Date(), new Date());
    await zipDirectory(source, join(root, 'b.zip'));
    const zip = await readFile(join(root, 'a.zip'));
    assert.deepEqual(zip, await readFile(join(root, 'b.zip')));
    const start = 30 + zip.readUInt16LE(26);
    assert.equal(zip.subarray(30, start).toString(), 'café.txt');
    assert.equal(inflateRawSync(zip.subarray(start, start + zip.readUInt32LE(18))).toString(), 'synthetic payload');
    assert.equal(zip.readUInt32LE(zip.length - 22), 0x06054b50);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('release ZIP rejects private files before writing an artifact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'captain-archive-'));
  try {
    const source = join(root, 'source');
    await mkdir(source);
    await writeFile(join(source, '.env'), 'SYNTHETIC=private');
    await assert.rejects(zipDirectory(source, join(root, 'out.zip')), /Private or unsafe/);
    await assert.rejects(readFile(join(root, 'out.zip')), { code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});
