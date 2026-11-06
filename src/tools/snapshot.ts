// Headless snapshot: boot the engine against a simulated Stream Deck + and write what the
// device would show to a PNG. Handy for quick visual iteration and for automated agents.
//   node src/tools/snapshot.ts out.png [--data DIR] [--page N]

import { createCanvas, loadImage } from '@napi-rs/canvas';
import { writeFileSync } from 'node:fs';
import { DeviceManager } from '../device/manager.ts';
import { Engine } from '../engine/engine.ts';
import { Store } from '../engine/store.ts';
import { encodeKeysInput, encodeEncoderRotateInput } from '../protocol/reports.ts';
import type { SimulatedStreamDeck } from '../device/sim-transport.ts';

export async function composeSim(sim: SimulatedStreamDeck): Promise<Buffer> {
  const m = sim.model;
  const kp = m.keyImage.width;
  const gap = 24;
  const W = Math.max(m.columns * kp + (m.columns + 1) * gap, (m.lcd?.width ?? 0) + gap * 2);
  const H = m.rows * kp + (m.rows + 1) * gap + (m.lcd ? m.lcd.height + gap : 0);
  const c = createCanvas(W, H);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#1b1b1f';
  ctx.fillRect(0, 0, W, H);
  const x0 = (W - (m.columns * kp + (m.columns - 1) * gap)) / 2;
  for (let i = 0; i < m.columns * m.rows; i++) {
    const x = x0 + (i % m.columns) * (kp + gap);
    const y = gap + Math.floor(i / m.columns) * (kp + gap);
    ctx.fillStyle = '#000';
    ctx.fillRect(x, y, kp, kp);
    const img = sim.fb.keys[i];
    if (img) ctx.drawImage(await loadImage(Buffer.from(img)), x, y, kp, kp);
  }
  if (m.lcd) {
    const lx = (W - m.lcd.width) / 2;
    const ly = m.rows * (kp + gap) + gap;
    ctx.fillStyle = '#000';
    ctx.fillRect(lx, ly, m.lcd.width, m.lcd.height);
    for (const r of sim.fb.lcd) ctx.drawImage(await loadImage(Buffer.from(r.image)), lx + r.rect.x, ly + r.rect.y, r.rect.width, r.rect.height);
  }
  return c.encode('png');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const out = args.find((a) => !a.startsWith('--')) ?? 'snapshot.png';
  const di = args.indexOf('--data');
  const store = new Store(di >= 0 ? args[di + 1] : undefined);
  store.config.settings.executeActions = false;
  const manager = new DeviceManager();
  const engine = new Engine(store, manager);
  const dev = await manager.addSimulator('plus', { pageLatencyMs: 0 });
  const sim = manager.simFor(dev)!;
  await new Promise((r) => setTimeout(r, 800));
  if (args.includes('--demo')) {
    // Exercise a few inputs: count up, turn dial 1 (brightness) and dial 3 (counter)
    for (let i = 0; i < 3; i++) {
      const st = new Array(8).fill(false);
      st[6] = true;
      sim.inject(encodeKeysInput(st));
      sim.inject(encodeKeysInput(new Array(8).fill(false)));
    }
    sim.inject(encodeEncoderRotateInput([0, 0, 5, 0]));
    await new Promise((r) => setTimeout(r, 600));
  }
  writeFileSync(out, await composeSim(sim));
  console.log(`wrote ${out}`);
  void engine;
  await manager.stop();
  process.exit(0);
}
