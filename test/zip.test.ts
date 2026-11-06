import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crc32, deflateRawSync } from 'node:zlib';
import { createCanvas } from '@napi-rs/canvas';
import { importElgatoProfile } from '../src/engine/elgato-import.ts';
import { readZip } from '../src/engine/zip.ts';
import { uuidToPageDir } from '../src/protocol/elgato-ids.ts';

type Entry = [name: string, contents: string | Buffer, claimedSize?: number];

function archive(...entries: Entry[]): Buffer {
  const files: Buffer[] = [];
  const index: Buffer[] = [];
  let offset = 0;
  for (const [name, contents, claimedSize] of entries) {
    const filename = Buffer.from(name);
    const bytes = Buffer.isBuffer(contents) ? contents : Buffer.from(contents);
    const compressed = deflateRawSync(bytes);
    const size = claimedSize ?? bytes.length;
    const checksum = crc32(bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(filename.length, 26);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(8, 10);
    directory.writeUInt32LE(checksum, 16);
    directory.writeUInt32LE(compressed.length, 20);
    directory.writeUInt32LE(size, 24);
    directory.writeUInt16LE(filename.length, 28);
    directory.writeUInt32LE(offset, 42);
    files.push(local, filename, compressed);
    index.push(directory, filename);
    offset += local.length + filename.length + compressed.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(index.reduce((sum, chunk) => sum + chunk.length, 0), 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...files, ...index, end]);
}

test('ZIP reads bounded deflate entries', () => {
  assert.equal(Buffer.from(readZip(archive(['manifest.json', '{}'])).get('manifest.json')!).toString(), '{}');
});

test('ZIP rejects traversal and compressed output beyond its stated bounds', () => {
  assert.throws(() => readZip(archive(['../manifest.json', '{}'])), /Unsafe profile archive entry/);
  assert.throws(() => readZip(archive(['manifest.json', 'payload', 0xffffffff])), /Expanded profile archive is too large/);
  assert.throws(() => readZip(archive(['manifest.json', 'x'.repeat(16_384), 32])), /larger than/);
});

test('imports actions, images and folders from a synthetic Stream Deck + profile', async () => {
  const mainId = '10000000-0000-4000-8000-000000000001';
  const nextId = '10000000-0000-4000-8000-000000000002';
  const folderId = '10000000-0000-4000-8000-000000000003';
  const root = 'fixture.sdProfile';
  const page = (id: string) => `${root}/Profiles/${uuidToPageDir(id)}`;
  const png = await createCanvas(1, 1).encode('png');
  const fixture = archive(
    [`${root}/manifest.json`, JSON.stringify({ Name: 'Fixture', Version: '2.0', Device: { Model: '20GBD9901' }, Pages: { Pages: [mainId, nextId] } })],
    [`${page(mainId)}/manifest.json`, JSON.stringify({ Controllers: [
      { Type: 'Keypad', Actions: {
        '0,0': { UUID: 'com.elgato.streamdeck.profile.openchild', Settings: { ProfileUUID: folderId }, States: [{ Title: 'Utilities', Image: 'folder.png' }] },
        '1,0': { UUID: 'example.fixture.plugin', Name: 'Fixture plugin' },
      } },
      { Type: 'Encoder', Actions: {
        '0,0': { UUID: 'com.elgato.streamdeck.system.hotkey', Settings: { Hotkeys: [{ QTKeyCode: 0x5a, KeyCtrl: true }] } },
        '1,0': { UUID: 'com.elgato.streamdeck.system.multimedia' },
      } },
    ] })],
    [`${page(mainId)}/folder.png`, png],
    [`${page(nextId)}/manifest.json`, '{}'],
    [`${page(folderId)}/manifest.json`, JSON.stringify({ Controllers: [{ Type: 'Keypad', Actions: {
      '0,0': { UUID: 'com.elgato.streamdeck.profile.backtoparent' },
    } }] })],
  );

  const { profile, warnings } = importElgatoProfile(fixture, (image, ext) => {
    assert.equal(ext, 'png');
    assert.deepEqual(Buffer.from(image), png);
    return 'folder.png';
  });
  assert.equal(profile.modelId, 'plus');
  assert.deepEqual(profile.pageOrder, [mainId, nextId]);
  const main = profile.pages[mainId]!;
  assert.equal(main.dials[0]?.type, 'system.hotkey');
  assert.deepEqual(main.dials[0]?.settings.left, { key: 'z', cmd: false, ctrl: true, opt: false, shift: false });
  assert.equal(main.dials[1]?.type, 'system.volume');
  assert.equal(main.keys[0]?.type, 'sd.folder');
  assert.equal(main.keys[0]?.settings.folderId, folderId);
  assert.deepEqual(main.keys[0]?.appearance.icon, { kind: 'image', id: 'folder.png' });
  assert.equal(profile.pages[folderId]?.parentId, mainId);
  assert.equal(profile.pages[folderId]?.keys[0]?.type, 'sd.back');
  assert.equal(main.keys[1]?.type, 'unsupported');
  assert.ok(warnings.some(w => w.includes('example.fixture.plugin')));
});
