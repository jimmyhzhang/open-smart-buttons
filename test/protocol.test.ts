import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PageAssembler,
  decodeFeatureSet,
  decodeFirmware,
  decodeInput,
  decodeOutputPage,
  decodeSerial,
  encodeBrightness,
  encodeEncoderPressInput,
  encodeEncoderRotateInput,
  encodeFirmwareReply,
  encodeKeyImagePages,
  encodeKeysInput,
  encodeLcdPages,
  encodeSerialReply,
  encodeSleepDelay,
  encodeTouchInput,
} from '../src/protocol/reports.ts';
import { pageDirToUuid, uuidToPageDir } from '../src/protocol/elgato-ids.ts';
import { modelByProductId } from '../src/protocol/models.ts';

test('feature reports match their wire-format fixtures', () => {
  assert.deepEqual([...encodeBrightness(55).subarray(0, 4)], [0x03, 0x08, 55, 0]);
  assert.equal(encodeBrightness(55).length, 32);
  assert.deepEqual([...encodeSleepDelay(0x01020304).subarray(0, 6)], [0x03, 0x0d, 4, 3, 2, 1]);
  assert.deepEqual(decodeFeatureSet(encodeBrightness(150)), { cmd: 'brightness', percent: 100 });
  assert.deepEqual(decodeFeatureSet(encodeSleepDelay(300)), { cmd: 'sleepDelay', seconds: 300 });
});

test('key image paging: header 02 07 key last lenLE pageLE, 1016-byte chunks', () => {
  const img = new Uint8Array(2500).map((_, i) => i & 0xff);
  const pages = encodeKeyImagePages(5, img);
  assert.equal(pages.length, 3);
  assert.deepEqual([...pages[0]!.subarray(0, 8)], [0x02, 0x07, 5, 0, 0xf8, 0x03, 0, 0]);
  assert.deepEqual([...pages[2]!.subarray(0, 8)], [0x02, 0x07, 5, 1, 2500 - 2032 & 0xff, (2500 - 2032) >> 8, 2, 0]);
  const asm = new PageAssembler();
  let out = null;
  for (const p of pages) out = asm.push(decodeOutputPage(p));
  assert.ok(out && out.target === 'key');
  assert.equal(out.key, 5);
  assert.deepEqual(out.image, img);
});

test('LCD paging: 16-byte header with x,y,w,h,last,page,len', () => {
  const img = new Uint8Array(1500).fill(7);
  const pages = encodeLcdPages({ x: 200, y: 0, width: 200, height: 100 }, img);
  assert.equal(pages.length, 2);
  assert.deepEqual([...pages[0]!.subarray(0, 16)], [0x02, 0x0c, 200, 0, 0, 0, 200, 0, 100, 0, 0, 0, 0, 0xf0, 0x03, 0]);
  const p1 = decodeOutputPage(pages[1]!);
  assert.equal(p1.cmd, 'lcd');
  if (p1.cmd === 'lcd') {
    assert.equal(p1.last, true);
    assert.equal(p1.page, 1);
    assert.equal(p1.data.length, 1500 - 1008);
  }
});

test('input reports round-trip', () => {
  const k = decodeInput(encodeKeysInput([false, true, false, false, false, false, false, true]), 8, 4);
  assert.deepEqual(k, { kind: 'keys', states: [false, true, false, false, false, false, false, true] });
  assert.deepEqual(decodeInput(encodeEncoderRotateInput([0, -3, 2, 0]), 8, 4), { kind: 'encoderRotate', deltas: [0, -3, 2, 0] });
  assert.deepEqual(decodeInput(encodeEncoderPressInput([true, false, false, false]), 8, 4), {
    kind: 'encoderPress',
    states: [true, false, false, false],
  });
  assert.deepEqual(decodeInput(encodeTouchInput('swipe', 10, 50, 700, 60), 8, 4), {
    kind: 'touch', type: 'swipe', x: 10, y: 50, x2: 700, y2: 60,
  });
  assert.deepEqual(decodeInput(encodeTouchInput('long', 410, 30), 8, 4), { kind: 'touch', type: 'long', x: 410, y: 30 });
});

test('Neo raw input uses eight ordered keys followed by two touch points', () => {
  // Independent of encodeKeysInput: the layout used by rust-elgato-streamdeck's
  // read_input/read_button_states is [report id, type, length LE16, 10 states].
  const report = Uint8Array.from([0x01, 0x00, 0x0a, 0x00, 0, 1, 0, 0, 0, 0, 0, 1, 1, 0]);
  assert.deepEqual(decodeInput(report, 10, 0), {
    kind: 'keys', states: [false, true, false, false, false, false, false, true, true, false],
  });
});

test('partial input snapshots are unknown rather than fabricated releases or coordinates', () => {
  for (const report of [
    Uint8Array.from([0x01, 0x00]),
    Uint8Array.from([0x01, 0x00, 0x0a, 0x00, 1]),
    Uint8Array.from([0x01, 0x02, 0x0e, 0x00, 1]),
    Uint8Array.from([0x01, 0x02, 0x0e, 0x00, 3, 0, 10, 0, 20, 0]),
    Uint8Array.from([0x01, 0x03, 0x05, 0x00, 0, 1]),
  ]) {
    assert.equal(decodeInput(report, 10, 4).kind, 'unknown');
  }
});

test('firmware and serial replies', () => {
  assert.equal(decodeFirmware(encodeFirmwareReply('1.05.009')), '1.05.009');
  assert.equal(decodeSerial(encodeSerialReply('TEST-NEO-001')), 'TEST-NEO-001');
});

test('Elgato page-directory id codec matches synthetic UUID vectors', () => {
  const vectors = [
    ['12345678-9abc-4def-8123-456789abcdef', '28Q5CV4QNH6VW0938LJOJAVDTSZ'],
    ['00000000-0000-4000-8000-000000000001', '00000000010010000000000004Z'],
  ] as const;
  for (const [uuid, directory] of vectors) {
    assert.equal(pageDirToUuid(directory), uuid);
    assert.equal(uuidToPageDir(uuid), directory);
  }
});

test('model table', () => {
  assert.equal(modelByProductId(0x0084)?.codename, '20GBD9901');
  assert.equal(modelByProductId(0x0084)?.lcd?.width, 800);
});

test('Neo info bar paging matches rust-elgato-streamdeck write_lcd_fill', async () => {
  const { encodeInfoBarPages } = await import('../src/protocol/reports.ts');
  const img = new Uint8Array(1500).fill(1);
  const p = encodeInfoBarPages(img);
  assert.equal(p.length, 2);
  assert.deepEqual([...p[0]!.subarray(0, 8)], [0x02, 0x0b, 0, 0, 0xf8, 0x03, 0, 0]);
  assert.deepEqual([...p[1]!.subarray(0, 8)], [0x02, 0x0b, 0, 1, (1500 - 1016) & 0xff, (1500 - 1016) >> 8, 1, 0]);
});
