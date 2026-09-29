// Reproducible ZIP32 writer: sorted UTF-8 paths, fixed timestamp, no shell,
// no symlinks and no private state. Archives are deliberately below 4 GiB.
import { lstat, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';

const table = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  return value >>> 0;
});
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ table[(crc ^ byte) & 255];
  return (crc ^ 0xffffffff) >>> 0;
}
function safePath(path) {
  return path.split('/').every(part => part && part !== '.' && part !== '..' &&
    !/[\\:\x00-\x1f]/.test(part) &&
    !/^(?:\.git|node_modules|runtime|research|experiments|profiles?|\.cache)$/i.test(part) &&
    (!/^\.env(?:\.|$)/i.test(part) || part === '.env.example') &&
    !/\.(?:pem|key|p12|pfx|sqlite|db|log|trace)$/i.test(part));
}
export async function zipDirectory(source, destination, { prefix = '' } = {}) {
  if (prefix && !safePath(prefix)) throw new Error('Unsafe archive prefix.');
  const files = [];
  async function walk(directory, relative = '') {
    if ((await lstat(directory)).isSymbolicLink()) throw new Error('Archive symlink refused.');
    for (const name of (await readdir(directory)).sort()) {
      const path = relative ? `${relative}/${name}` : name;
      if (!safePath(path)) throw new Error('Private or unsafe archive entry refused: ' + path);
      const absolute = join(directory, name);
      const stat = await lstat(absolute);
      if (stat.isSymbolicLink()) throw new Error('Archive symlink refused: ' + path);
      if (stat.isDirectory()) await walk(absolute, path);
      else if (stat.isFile()) files.push({ absolute, path });
      else throw new Error('Non-regular archive entry refused: ' + path);
    }
  }
  await walk(source);
  if (files.length >= 65535) throw new Error('ZIP32 entry limit exceeded.');
  const payloads = [], directory = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(prefix ? `${prefix}/${file.path}` : file.path, 'utf8');
    const bytes = await readFile(file.absolute);
    const compressed = deflateRawSync(bytes, { level: 9 });
    if (name.length > 65535 || bytes.length >= 0xffffffff || compressed.length >= 0xffffffff)
      throw new Error('ZIP32 file limit exceeded.');
    const crc = crc32(bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(33, 12); // 1980-01-01, 00:00:00
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(bytes.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    local.copy(central, 6, 4, 30);
    central.writeUInt32LE(offset, 42);
    directory.push(central, name);
    payloads.push(local, name, compressed);
    offset += local.length + name.length + compressed.length;
    if (offset >= 0xffffffff) throw new Error('ZIP32 archive limit exceeded.');
  }
  const centralBytes = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  await writeFile(destination, Buffer.concat([...payloads, centralBytes, end]));
}
