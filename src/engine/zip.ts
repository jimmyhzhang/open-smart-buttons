// Minimal ZIP reader (stored + deflate) for .streamDeckProfile files. No dependencies.

import { inflateRawSync } from 'node:zlib';

const MAX_ARCHIVE = 12 * 1024 * 1024;
const MAX_ENTRY = 8 * 1024 * 1024;
const MAX_EXPANDED = 32 * 1024 * 1024;

export function readZip(buf: Uint8Array): Map<string, Uint8Array> {
  if (buf.byteLength > MAX_ARCHIVE) throw new Error('Profile archive is too large.');
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) {
    if (b.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Not a zip file');
  const count = b.readUInt16LE(eocd + 10);
  if (count > 2048 || b.readUInt16LE(eocd + 4) !== 0 || b.readUInt16LE(eocd + 6) !== 0) throw new Error('Unsupported profile archive.');
  const directoryEnd = b.readUInt32LE(eocd + 16) + b.readUInt32LE(eocd + 12);
  if (directoryEnd > eocd) throw new Error('Corrupt zip directory');
  let p = b.readUInt32LE(eocd + 16);
  const out = new Map<string, Uint8Array>();
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (p + 46 > directoryEnd || b.readUInt32LE(p) !== 0x02014b50) throw new Error('Corrupt zip directory');
    const method = b.readUInt16LE(p + 10);
    const csize = b.readUInt32LE(p + 20);
    const usize = b.readUInt32LE(p + 24);
    const nameLen = b.readUInt16LE(p + 28);
    const extraLen = b.readUInt16LE(p + 30);
    const commentLen = b.readUInt16LE(p + 32);
    const local = b.readUInt32LE(p + 42);
    const mode = b.readUInt32LE(p + 38) >>> 16;
    const name = b.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;
    if (p > directoryEnd || !name || name.startsWith('/') || name.includes('\\') || name.includes('\0') ||
      /^[A-Za-z]:/.test(name) || name.split('/').includes('..') || (mode & 0xf000) === 0xa000) throw new Error('Unsafe profile archive entry.');
    if (name.endsWith('/')) continue;
    if (out.has(name) || local + 30 > eocd || b.readUInt32LE(local) !== 0x04034b50) throw new Error('Corrupt zip entry.');
    if (usize > MAX_ENTRY || (total += usize) > MAX_EXPANDED) throw new Error('Expanded profile archive is too large.');
    const lNameLen = b.readUInt16LE(local + 26);
    const lExtraLen = b.readUInt16LE(local + 28);
    const start = local + 30 + lNameLen + lExtraLen;
    if (start + csize > eocd) throw new Error('Corrupt zip entry.');
    const raw = b.subarray(start, start + csize);
    const bytes = method === 0 ? raw : method === 8 ? inflateRawSync(raw, { maxOutputLength: Math.max(usize, 1) }) : null;
    if (!bytes || bytes.byteLength !== usize) throw new Error('Unsupported or corrupt zip entry.');
    out.set(name, bytes);
  }
  return out;
}
