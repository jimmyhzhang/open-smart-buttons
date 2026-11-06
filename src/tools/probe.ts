// Hardware probe for iteration 1: verifies the protocol against a real device.
//   node src/tools/probe.ts            list devices, open the first supported one, run the checks
//   node src/tools/probe.ts --listen   also print input events for 30 s (press keys, turn dials, touch)
// Quit the Elgato Stream Deck app first so it releases the device.

import { createCanvas } from '@napi-rs/canvas';
import { listElgatoHid, loadNodeHid, openNodeHid } from '../device/node-hid-transport.ts';
import { StreamDeckDevice } from '../device/streamdeck.ts';
import { keyCount, modelByProductId } from '../protocol/models.ts';
import { summarizeReport } from '../protocol/reports.ts';

const hid = await loadNodeHid();
if (!hid) {
  console.error('node-hid is not installed or failed to load. Run `npm install` on this machine.');
  process.exit(1);
}
const list = await listElgatoHid();
if (!list.length) {
  console.log('No Elgato HID devices found. Is the Stream Deck plugged in?');
  process.exit(0);
}
console.log('Elgato HID interfaces:');
for (const d of list) {
  const m = modelByProductId(d.productId);
  console.log(`  ${m?.name ?? 'unknown'}  pid=0x${d.productId.toString(16).padStart(4, '0')}  serial=${d.serialNumber}  usagePage=0x${(d.usagePage ?? 0).toString(16)}  path=${d.path}`);
}
const target = list.find((d) => modelByProductId(d.productId)?.supported);
if (!target) process.exit(0);
const model = modelByProductId(target.productId)!;

let t;
try {
  t = await openNodeHid(target);
} catch (e) {
  console.error(`Could not open the device: ${(e as Error).message}\nQuit the Elgato Stream Deck app and try again.`);
  process.exit(1);
}
const dev = new StreamDeckDevice(t, model);
await dev.open();
console.log(`\nOpened ${model.name}: serial=${dev.serial} firmware=${dev.firmware}`);

function solid(w: number, h: number, color: string, label: string): Promise<Buffer> {
  const c = createCanvas(w, h);
  const ctx = c.getContext('2d');
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#fff';
  ctx.font = `bold ${Math.round(h * 0.3)}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, w / 2, h / 2);
  // orientation marker: top-left corner
  ctx.fillStyle = '#ff0';
  ctx.fillRect(0, 0, w * 0.18, h * 0.18);
  return c.encode('jpeg', 90);
}

console.log('Brightness sweep 10 → 100 %');
for (const b of [10, 40, 70, 100]) {
  await dev.setBrightness(b);
  await new Promise((r) => setTimeout(r, 250));
}
const colors = ['#e11d48', '#f97316', '#eab308', '#22c55e', '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899'];
console.log('Painting keys (yellow square should be top-left on every key)');
const px = model.keyImage.width;
for (let i = 0; i < keyCount(model); i++) await dev.setKeyImage(i, await solid(px, px, colors[i % colors.length]!, String(i)));
if (model.lcd) {
  console.log('Painting the touch strip, one zone per dial');
  for (let z = 0; z < model.encoders; z++) {
    const r = dev.zoneRect(z);
    await dev.setLcdImage(r, await solid(r.width, r.height, colors[(z * 2) % colors.length]!, `dial ${z}`));
  }
}

if (model.touchPoints) {
  console.log('Lighting the touch points (left red, right blue)');
  await dev.setTouchPointColor(0, 255, 0, 0);
  await dev.setTouchPointColor(1, 0, 80, 255);
}

if (model.infoBar) {
  // Neo info bar: 02 0b paged JPEG, rotated 180° (matches rust-elgato-streamdeck / node-elgato-stream-deck).
  const { orientKey } = await import('../render/renderer.ts');
  const ib = model.infoBar;
  const up = await solid(ib.width, ib.height, '#0e7490', 'INFO BAR');
  await dev.setInfoBarImage(await orientKey(up, ib.width, true, true, ib.height), up);
  console.log('Painted the info bar (teal, "INFO BAR", yellow square top-left)');
}

if (process.argv.includes('--listen')) {
  dev.on('touchPointDown', (i) => console.log(`  touchPoint ${i}`));
  console.log('\nListening for 30 s: press keys, turn and press dials, tap/hold/swipe the strip…');
  dev.on('report', (dir, b) => dir === 'in' && console.log('  ', summarizeReport('in', b, keyCount(model) + (model.touchPoints ?? 0), model.encoders)));
  dev.on('keyDown', (k) => console.log(`  keyDown ${k}`));
  dev.on('dialRotate', (d, n) => console.log(`  dialRotate ${d} ${n > 0 ? '+' : ''}${n}`));
  dev.on('touch', (e) => console.log(`  touch ${e.type} zone ${e.zone} (${e.x},${e.y})${e.x2 !== undefined ? ` → (${e.x2},${e.y2})` : ''}`));
  await new Promise((r) => setTimeout(r, 30000));
}
console.log('\nDone. Run `npm start` to use the full app.');
await dev.close();
process.exit(0);
