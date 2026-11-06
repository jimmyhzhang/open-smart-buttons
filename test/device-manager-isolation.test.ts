import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DeviceManager } from '../src/device/manager.ts';

test('a no-HID instance cannot enumerate or claim USB via manual UI RPCs', async () => {
  const manager = new DeviceManager();
  await manager.start({ hid: false });
  await manager.scan();
  assert.deepEqual(manager.list(), []);
  await assert.rejects(manager.connect('fixture-hid-path'), /USB is disabled/);
  const sim = await manager.addSimulator('neo');
  assert.equal(sim.kind, 'sim');
  assert.equal(manager.list().length, 1);
  await manager.stop();
});

import { SimulatedStreamDeck } from '../src/device/sim-transport.ts';
import { modelById } from '../src/protocol/models.ts';
import { Store } from '../src/engine/store.ts';
import { Engine } from '../src/engine/engine.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('reconnect closes before opening, coalesces repeated clicks, and preserves the device profile', async t => {
  const model = modelById('neo')!;
  const info = { path: 'test-usb', vendorId: 0xfd9, productId: model.productIds[0]!, serialNumber: 'TESTNEO', kind: 'usb' as const };
  let held = false, opens = 0, closes = 0;
  const manager = new DeviceManager({
    available: async () => true, list: async () => [info],
    open: async () => {
      assert.equal(held, false, 'previous handle must be released'); held = true; opens++;
      await new Promise(r => setTimeout(r, 10));
      const transport = new SimulatedStreamDeck(model, { serial: 'TESTNEO', pageLatencyMs: 0 });
      Object.assign(transport.info, info);
      const close = transport.close.bind(transport);
      transport.close = async () => { await close(); held = false; closes++; };
      return transport;
    },
  });
  const dir = mkdtempSync(join(tmpdir(), 'sdp-reconnect-'));
  const store = new Store(dir); store.config.settings.executeActions = false;
  const engine = new Engine(store, manager);
  t.after(async () => { await manager.stop(); store.flush(); rmSync(dir, { recursive: true, force: true }); });
  await manager.start({ hid: true, pollMs: 10000 });
  const first = [...manager.devices.values()][0]!;
  const profileId = engine.sessions.get(first.id)!.profileId;
  const a = manager.reconnect(first.id), b = manager.reconnect(first.id);
  assert.equal(a, b);
  const next = await a;
  assert.notEqual(first, next); assert.equal(opens, 2); assert.equal(closes, 1);
  assert.equal(engine.sessions.get(next.id)!.profileId, profileId);
  await manager.disconnect(next.id);
  assert.equal(manager.list()[0]?.deviceId, undefined);
  await manager.scan(); assert.equal(opens, 2, 'manual disconnect must stay disconnected');
  await Promise.all([manager.connect(info.path), manager.connect(info.path)]);
  assert.equal(opens, 3, 'concurrent connect requests must share one open');
});
