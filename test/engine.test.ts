import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeviceManager } from '../src/device/manager.ts';
import { Engine } from '../src/engine/engine.ts';
import { Store } from '../src/engine/store.ts';
import { createRpc } from '../src/server/rpc.ts';
import { encodeKeysInput, encodeEncoderRotateInput, encodeTouchInput } from '../src/protocol/reports.ts';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function boot() {
  const store = new Store(mkdtempSync(join(tmpdir(), 'sdp-')));
  store.config.settings.executeActions = false;
  const manager = new DeviceManager();
  const engine = new Engine(store, manager);
  const rpc = createRpc(engine);
  const dev = await manager.addSimulator('plus', { pageLatencyMs: 0 });
  for (let i = 0; i < 40 && !manager.simFor(dev)!.fb.keys.every(Boolean); i++) await wait(50);
  await wait(100);
  return { store, manager, engine, rpc, dev, sim: manager.simFor(dev)!, session: engine.sessions.get(dev.id)! };
}

test('starter profile renders all keys and touch zones through the simulator', async () => {
  const { sim, manager } = await boot();
  assert.ok(sim.fb.keys.every((k) => k && k.length > 500), 'every key received a JPEG');
  assert.equal(sim.fb.lcd.length, 4);
  assert.equal(sim.fb.brightness, 70);
  await manager.stop();
});

test('input routing: counter key, dial rotation, swipe changes page, folders', async () => {
  const { sim, session, engine, manager, store } = await boot();
  const page = session.page()!;
  const counter = page.keys[6]!;
  const press = (k: number) => {
    const s = new Array(8).fill(false);
    s[k] = true;
    sim.inject(encodeKeysInput(s));
    sim.inject(encodeKeysInput(new Array(8).fill(false)));
  };
  press(6);
  press(6);
  assert.equal(engine.stateFor(counter.id).n, 2);
  sim.inject(encodeEncoderRotateInput([0, -3, 0, 0])); // brightness dial
  await wait(50);
  assert.equal(sim.fb.brightness, 55);
  const first = session.pageId;
  sim.inject(encodeTouchInput('swipe', 700, 50, 100, 50));
  assert.notEqual(session.pageId, first);
  sim.inject(encodeTouchInput('swipe', 100, 50, 700, 50));
  assert.equal(session.pageId, first);
  press(3); // Apps folder
  assert.equal(store.profile(session.profileId)!.pages[session.pageId]!.name, 'Apps');
  press(0); // Back
  assert.equal(session.pageId, first);
  await manager.stop();
});

test('rpc: assign, move, paste and clear slots; folder pages are created and cleaned up', async () => {
  const { rpc, session, store, manager } = await boot();
  const profileId = session.profileId;
  const pageId = session.pageId;
  const p = () => store.profile(profileId)!;
  await rpc['slots.assign']!({ profileId, pageId, kind: 'key', index: 7, type: 'sd.folder' });
  const folderId = String(p().pages[pageId]!.keys[7]!.settings.folderId);
  assert.ok(p().pages[folderId], 'folder page created');
  assert.equal(p().pages[folderId]!.keys[0]!.type, 'sd.back');
  await rpc['slots.move']!({ profileId, from: { pageId, kind: 'key', index: 7 }, to: { pageId, kind: 'key', index: 0 } });
  assert.equal(p().pages[pageId]!.keys[0]!.type, 'sd.folder');
  await assert.rejects(async () => rpc['slots.assign']!({ profileId, pageId, kind: 'dial', index: 0, type: 'system.website' }));
  await rpc['slots.clear']!({ profileId, pageId, kind: 'key', index: 0, deleteFolder: true });
  assert.equal(p().pages[folderId], undefined, 'folder page removed with its key');
  await manager.stop();
});

test('Stream Deck Neo: flipped key images, info bar via 02 0b, touch points page and light up', async () => {
  const store = new Store(mkdtempSync(join(tmpdir(), 'sdp-')));
  store.config.settings.executeActions = false;
  const manager = new DeviceManager();
  const engine = new Engine(store, manager);
  const dev = await manager.addSimulator('neo', { pageLatencyMs: 0 });
  const sim = manager.simFor(dev)!;
  for (let i = 0; i < 60 && !(sim.fb.keys.every(Boolean) && sim.fb.infoBar); i++) await wait(50);
  assert.ok(sim.fb.keys.every(Boolean), 'all 8 keys painted');
  assert.ok(sim.fb.infoBar && sim.fb.infoBar[0] === 0xff && sim.fb.infoBar[1] === 0xd8, 'info bar received a JPEG');
  assert.deepEqual(sim.fb.touchPoints, ['#5a5a5a', '#5a5a5a'], 'touch points lit when there are several pages');
  const s = engine.sessions.get(dev.id)!;
  const first = s.pageId;
  const st = new Array(10).fill(false);
  st[9] = true; // right touch point
  sim.inject(encodeKeysInput(st));
  sim.inject(encodeKeysInput(new Array(10).fill(false)));
  assert.notEqual(s.pageId, first, 'right touch point → next page');
  st[9] = false;
  st[8] = true;
  sim.inject(encodeKeysInput(st));
  assert.equal(s.pageId, first, 'left touch point → previous page');
  await manager.stop();
});

test('icon picks: an explicit icon always wins; with no pick the live state icon is used', async () => {
  const { rpc, session, engine, manager } = await boot();
  const base = { profileId: session.profileId, pageId: session.pageId, kind: 'key', index: 1 };
  const id = (await rpc['slots.assign']!({ ...base, type: 'system.volume' })) as string;
  engine.stateFor(id).muted = true;
  const icon = () => (session.keyVisual(1)!.icon as { name?: string }).name;
  assert.equal(icon(), 'volume-x', 'auto icon follows mute state');
  await rpc['slots.update']!({ ...base, appearance: { icon: { kind: 'lucide', name: 'volume-2' } } });
  assert.equal(icon(), 'volume-2', 'picking the default-looking icon is still honored');
  await rpc['slots.update']!({ ...base, appearance: { icon: null } });
  assert.equal(icon(), 'volume-x', 'reset returns to automatic');
  await manager.stop();
});

test('Volume Down shows the muted icon at zero and restores the normal icon when sound returns', async (t) => {
  const { rpc, session, engine, manager, dev, sim } = await boot();
  t.after(() => manager.stop());
  const base = { profileId: session.profileId, pageId: session.pageId, kind: 'key', index: 1 };
  const normalIcon = { kind: 'lucide', name: 'volume-1' };
  const iconName = () => {
    const icon = session.keyVisual(1)?.icon;
    return icon?.kind === 'lucide' ? icon.name : undefined;
  };
  await engine.platform.setVolume(3);
  await rpc['slots.assign']!({
    ...base, type: 'system.volume', configured: true,
    settings: { mode: 'down', mutedIconWhenSilent: true },
    appearance: { icon: normalIcon },
  });
  await engine.refreshVolumeKeys(true);
  assert.equal(iconName(), normalIcon.name);

  sim.inject(encodeKeysInput([false, true, false, false, false, false, false, false]));
  sim.inject(encodeKeysInput(Array(8).fill(false)));
  for (let i = 0; i < 50 && iconName() !== 'volume-x'; i++) await wait(20);
  assert.deepEqual(await engine.platform.getVolume(), { volume: 0, muted: false });
  assert.equal(iconName(), 'volume-x');

  await rpc['slots.assign']!({ ...base, index: 2, type: 'system.volume', configured: true, settings: { mode: 'up' } });
  await engine.testAction(dev.id, 'key', 2);
  assert.deepEqual(await engine.platform.getVolume(), { volume: 6, muted: false });
  for (let i = 0; i < 120 && iconName() !== normalIcon.name; i++) await wait(20);
  assert.equal(iconName(), normalIcon.name);
});

test('Volume Up after macOS muted at zero unmutes and clears the muted icon on the Volume Down key at once', async (t) => {
  const { rpc, session, engine, manager } = await boot();
  t.after(() => manager.stop());
  const base = { profileId: session.profileId, pageId: session.pageId, kind: 'key' };
  const iconName = (i: number) => { const icon = session.keyVisual(i)?.icon; return icon?.kind === 'lucide' ? icon.name : undefined; };
  await rpc['slots.assign']!({ ...base, index: 4, type: 'system.volume', configured: true, settings: { mode: 'down', mutedIconWhenSilent: true }, appearance: { icon: { kind: 'lucide', name: 'volume-1' } } });
  await rpc['slots.assign']!({ ...base, index: 5, type: 'system.volume', configured: true, settings: { mode: 'up' } });
  // macOS sets its mute flag when the level reaches zero.
  await engine.platform.setVolume(0);
  await engine.platform.setMuted(true);
  await engine.refreshVolumeKeys(true);
  assert.equal(iconName(4), 'volume-x');
  await engine.testAction(session.dev.id, 'key', 5);
  assert.deepEqual(await engine.platform.getVolume(), { volume: 6, muted: false }, 'raising the level unmutes, like the keyboard key');
  // No waiting for the 1 s background poll: the press refreshes every volume key on the page.
  assert.equal(iconName(4), 'volume-1');
  assert.equal(session.keyVisual(5)?.value, '6%', 'the Volume Up key shows the new level too');
});
