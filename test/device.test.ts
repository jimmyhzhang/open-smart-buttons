import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DeviceManager } from '../src/device/manager.ts';
import {
  encodeEncoderPressInput,
  encodeEncoderRotateInput,
  encodeKeysInput,
  encodeTouchInput,
} from '../src/protocol/reports.ts';

test('driver ↔ simulator: identity, images, LCD, brightness, input events', async () => {
  const mgr = new DeviceManager();
  const dev = await mgr.addSimulator('plus', { serial: 'SIMTEST01', firmware: '1.02.003', pageLatencyMs: 0 });
  const sim = mgr.simFor(dev)!;
  assert.equal(dev.serial, 'SIMTEST01');
  assert.equal(dev.firmware, '1.02.003');

  const jpeg = new Uint8Array(3000).map((_, i) => (i * 7) & 0xff);
  await dev.setKeyImage(3, jpeg);
  assert.deepEqual(sim.fb.keys[3], jpeg);

  await dev.setLcdImage(dev.zoneRect(2), jpeg.subarray(0, 1200));
  assert.equal(sim.fb.lcd.length, 1);
  assert.deepEqual(sim.fb.lcd[0]!.rect, { x: 400, y: 0, width: 200, height: 100 });

  await dev.setBrightness(42);
  assert.equal(sim.fb.brightness, 42);
  await dev.setSleepDelay(120);
  assert.equal(sim.fb.sleepDelay, 120);

  const events: string[] = [];
  dev.on('keyDown', (k) => events.push(`down${k}`));
  dev.on('keyUp', (k) => events.push(`up${k}`));
  dev.on('dialRotate', (d, t) => events.push(`rot${d}:${t}`));
  dev.on('dialDown', (d) => events.push(`ddown${d}`));
  dev.on('touch', (e) => events.push(`${e.type}@${e.zone}`));
  const st = new Array(8).fill(false);
  st[6] = true;
  sim.inject(encodeKeysInput(st));
  st[6] = false;
  sim.inject(encodeKeysInput(st));
  sim.inject(encodeEncoderRotateInput([0, 0, -2, 0]));
  sim.inject(encodeEncoderPressInput([false, true, false, false]));
  sim.inject(encodeTouchInput('tap', 650, 40));
  assert.deepEqual(events, ['down6', 'up6', 'rot2:-2', 'ddown1', 'tap@3']);
  await mgr.stop();
});

test('coalescing: rapid updates to the same key send only the newest image', async () => {
  const mgr = new DeviceManager();
  const dev = await mgr.addSimulator('plus', { pageLatencyMs: 2 });
  const sim = mgr.simFor(dev)!;
  const ps = [];
  for (let i = 0; i < 20; i++) ps.push(dev.setKeyImage(0, new Uint8Array(2000).fill(i)));
  await Promise.all(ps);
  assert.equal(sim.fb.keys[0]![0], 19);
  // first upload (2 pages) starts immediately, the 19 others coalesce into one more upload.
  assert.ok(sim.stats.outputReports <= 4, `sent ${sim.stats.outputReports} reports`);
  await mgr.stop();
});

test('unplug detaches the device', async () => {
  const mgr = new DeviceManager();
  const dev = await mgr.addSimulator('plus');
  let detached = false;
  mgr.on('detach', () => (detached = true));
  mgr.simFor(dev)!.unplug();
  assert.equal(detached, true);
  assert.equal(mgr.devices.size, 0);
});

test('Neo raw packets route each displayed key and touch point without remapping', async () => {
  const mgr = new DeviceManager();
  const dev = await mgr.addSimulator('neo', { pageLatencyMs: 0 });
  const sim = mgr.simFor(dev)!;
  const events: string[] = [];
  dev.on('keyDown', (k) => events.push(`down${k}`));
  dev.on('keyUp', (k) => events.push(`up${k}`));
  dev.on('touchPointDown', (k) => events.push(`touchDown${k}`));
  dev.on('touchPointUp', (k) => events.push(`touchUp${k}`));
  try {
    for (let i = 0; i < 10; i++) {
      const report = Uint8Array.from([0x01, 0x00, 0x0a, 0x00, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
      report[4 + i] = 1;
      sim.inject(report);
      sim.inject(report); // unchanged hardware state must not execute twice
      // A short report cannot cancel the held button.
      dev.injectInput(Uint8Array.from([0x01, 0x00, 0x0a, 0x00]));
      report[4 + i] = 0;
      sim.inject(report);
    }
    assert.deepEqual(events, [
      ...Array.from({ length: 8 }, (_, i) => [`down${i}`, `up${i}`]).flat(),
      'touchDown0', 'touchUp0', 'touchDown1', 'touchUp1',
    ]);
  } finally {
    await mgr.stop();
  }
});
