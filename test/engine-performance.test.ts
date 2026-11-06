import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DeviceManager } from '../src/device/manager.ts';
import { StreamDeckDevice } from '../src/device/streamdeck.ts';
import { Engine } from '../src/engine/engine.ts';
import { Store, starterProfile } from '../src/engine/store.ts';
import { newInstance } from '../src/engine/actions.ts';
import { createRpc } from '../src/server/rpc.ts';
import type { ActionInstance } from '../src/shared/types.ts';

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

async function boot(t: { after(fn: () => Promise<void>): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'sdp-engine-performance-'));
  const store = new Store(dir);
  store.config.settings.executeActions = false;
  const manager = new DeviceManager();
  const engine = new Engine(store, manager);
  const dev = await manager.addSimulator('neo', { serial: 'CACHE-TEST', pageLatencyMs: 0 });
  const sim = manager.simFor(dev)!;
  const session = engine.sessions.get(dev.id)!;
  for (let i = 0; i < 100 && !(sim.fb.keys.every(Boolean) && sim.fb.infoBar && sim.stats.featureReports >= 4); i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(sim.fb.infoBar && sim.fb.keys.every(Boolean), 'initial device rendering completed');
  t.after(async () => { await manager.stop(); store.flush(); rmSync(dir, { recursive: true, force: true }); });
  return { store, manager, engine, dev, sim, session, rpc: createRpc(engine) };
}

test('20 unchanged Neo config refreshes send zero extra feature reports; page/folder changes send only needed colors', async (t) => {
  const { engine, sim, session, store } = await boot(t);
  assert.deepEqual(sim.fb.touchPoints, ['#5a5a5a', '#5a5a5a']);
  let before = sim.stats.featureReports;
  for (let i = 0; i < 20; i++) { engine.configChanged(); await settle(); }
  assert.equal(sim.stats.featureReports - before, 0, 'previously emitted 40 redundant feature reports');

  const mainId = session.pageId;
  const folderId = String(session.page()!.keys[3]!.settings.folderId);
  before = sim.stats.featureReports;
  session.setPage(folderId);
  await settle();
  assert.equal(sim.stats.featureReports - before, 2);
  assert.deepEqual(sim.fb.touchPoints, ['#000000', '#000000']);
  for (let i = 0; i < 5; i++) { engine.configChanged(); await settle(); }
  assert.equal(sim.stats.featureReports - before, 2, 'editing inside a folder does not resend its unchanged color');

  session.setPage(mainId);
  await settle();
  assert.equal(sim.stats.featureReports - before, 4);
  const profile = store.profile(session.profileId)!;
  profile.pageOrder = [mainId];
  engine.configChanged();
  await settle();
  assert.equal(sim.stats.featureReports - before, 6);
  assert.deepEqual(sim.fb.touchPoints, ['#000000', '#000000'], 'one-page profiles turn page indicators off');
});

test('Neo reset/forced repaint and reconnection restore colors despite the previous cache', async (t) => {
  const { manager, engine, sim, session, dev } = await boot(t);
  const before = sim.stats.featureReports;
  await dev.reset();
  session.renderAll(true); // The device reset RPC uses a forced repaint when the device is ready.
  await settle();
  assert.equal(sim.stats.featureReports - before, 3, 'one reset plus both touch-point reports');
  session.renderAll();
  await settle();
  assert.equal(sim.stats.featureReports - before, 3);

  const previousId = dev.id;
  await manager.removeSimulator(previousId);
  const reconnected = await manager.addSimulator('neo', { serial: 'CACHE-TEST', pageLatencyMs: 0 });
  const newSim = manager.simFor(reconnected)!;
  for (let i = 0; i < 100 && newSim.stats.featureReports < 4; i++) await settle();
  assert.equal(reconnected.id, previousId, 'same device identity can reconnect');
  assert.notEqual(engine.sessions.get(reconnected.id), session);
  assert.equal(newSim.stats.featureReports, 4, 'new session sends brightness, sleep and both colors');
  assert.deepEqual(newSim.fb.touchPoints, ['#5a5a5a', '#5a5a5a']);
});

test('a failed touch-point update is retried on the next refresh', async (t) => {
  const { sim, session, dev, engine } = await boot(t);
  const original = dev.setTouchPointColor.bind(dev);
  let fail = true;
  const warnings: string[] = [];
  t.mock.method(engine, 'log', (level: string, message: string) => { if (level === 'warn') warnings.push(message); });
  t.mock.method(dev, 'setTouchPointColor', async (index: number, r: number, g: number, b: number) => {
    if (fail) { fail = false; throw new Error('fixture write failure'); }
    await original(index, r, g, b);
  });
  session.setPage(String(session.page()!.keys[3]!.settings.folderId));
  await settle();
  assert.match(warnings[0]!, /fixture write failure/);
  session.renderAll();
  await settle();
  assert.deepEqual(sim.fb.touchPoints, ['#000000', '#000000']);
  const reports = sim.stats.featureReports;
  session.renderAll();
  await settle();
  assert.equal(sim.stats.featureReports, reports, 'a successful retry is cached again');
});

test('repeated replacement prunes unreachable runtime/appearance ids and retains saved profile and nested states', async (t) => {
  const { store, engine, session, rpc, dev } = await boot(t);
  const profile = store.profile(session.profileId)!;
  const mainId = session.pageId;
  const main = session.page()!;
  const multi = newInstance('sd.multi', 'retained-multi');
  const nestedMulti = newInstance('sd.multi', 'retained-nested-multi');
  nestedMulti.settings.steps = [newInstance('util.toggle', 'retained-nested-toggle')];
  multi.settings.steps = [newInstance('util.counter', 'retained-nested-counter'), nestedMulti];
  main.keys[1] = multi;
  main.keys[0] = newInstance('util.counter', 'initial-replaced-counter');
  const other = starterProfile('neo');
  store.config.profiles.push(other);
  const otherCounter = other.pages[other.pageOrder[0]!]!.keys[6]!;
  const otherState = engine.stateFor(otherCounter.id);
  otherState.n = 17;
  const nestedState = engine.stateFor('retained-nested-counter');
  nestedState.n = 9;
  const toggleState = engine.stateFor('retained-nested-toggle');
  toggleState.on = true;
  engine.stateFor('retained-nested-multi').fixture = true;
  engine.configChanged();
  const before = engine.runtime.size;
  const replacedIds = ['initial-replaced-counter'];
  for (let i = 0; i < 30; i++) {
    const id = await rpc['slots.assign']!({ profileId: profile.id, pageId: mainId, kind: 'key', index: 0, type: 'util.counter' }) as string;
    replacedIds.push(id);
    await settle();
  }
  assert.equal(engine.runtime.size, before, '30 replacements retain no extra runtime entries');
  for (const id of replacedIds.slice(0, -1)) assert.equal(engine.runtime.has(id), false, 'removed actions are released');
  const appeared = (session as unknown as { appeared: Set<string> }).appeared;
  for (const id of replacedIds.slice(0, -1)) assert.equal(appeared.has(id), false, 'removed appearance ids are released');
  assert.ok(appeared.size <= main.keys.filter(Boolean).length);
  assert.equal(engine.runtime.get(otherCounter.id), otherState);
  assert.equal(engine.runtime.get('retained-nested-counter'), nestedState);
  assert.equal(engine.runtime.get('retained-nested-toggle'), toggleState);

  session.setPage(profile.pageOrder[1]!);
  engine.configChanged();
  session.setPage(mainId);
  engine.setSessionProfile(dev.id, other.id);
  engine.configChanged();
  engine.setSessionProfile(dev.id, profile.id);
  assert.equal(engine.runtime.get(otherCounter.id)!.n, 17, 'another saved profile keeps its state across navigation');
  assert.equal(engine.runtime.get('retained-nested-counter')!.n, 9);
  assert.equal(engine.runtime.get('retained-nested-toggle')!.on, true);

  multi.settings.steps = [];
  store.config.profiles = store.config.profiles.filter((p) => p.id !== other.id);
  engine.configChanged();
  for (const id of ['retained-nested-counter', 'retained-nested-multi', 'retained-nested-toggle', otherCounter.id]) {
    assert.equal(engine.runtime.has(id), false, 'deleting a nested step or profile releases its runtime');
  }
  assert.equal((multi.settings.steps as ActionInstance[]).length, 0);
});

test('a pending long press cannot revive runtime for an action replaced while its key is held', async (t) => {
  const { session, engine, rpc } = await boot(t);
  const base = { profileId: session.profileId, pageId: session.pageId, kind: 'key', index: 0, type: 'util.counter' };
  const removedId = await rpc['slots.assign']!(base) as string;
  session.handleKey(0, true);
  assert.equal(typeof engine.runtime.get(removedId)!.pressedAt, 'number');
  const replacementId = await rpc['slots.assign']!(base) as string;
  await new Promise((resolve) => setTimeout(resolve, 550));
  session.handleKey(0, false);
  assert.equal(engine.runtime.has(removedId), false);
  assert.notEqual(removedId, replacementId);
  assert.equal(engine.runtime.get(replacementId)!.n, undefined, 'the old held press does not reset or execute the new action');
});

test('quick key releases stay bound to the pressed action, skipping removed actions and following retained ones', async (t) => {
  const { session, engine, rpc } = await boot(t);
  const base = { profileId: session.profileId, pageId: session.pageId, kind: 'key', index: 0, type: 'util.counter' };
  const removedId = await rpc['slots.assign']!(base) as string;
  session.handleKey(0, true);
  const replacementId = await rpc['slots.assign']!(base) as string;
  session.handleKey(0, false);
  assert.equal(engine.runtime.has(removedId), false);
  assert.equal(engine.runtime.get(replacementId)!.n, undefined, 'the replacement never received this physical press');

  session.handleKey(0, true);
  await rpc['slots.move']!({ profileId: session.profileId, from: { pageId: session.pageId, kind: 'key', index: 0 }, to: { pageId: session.pageId, kind: 'key', index: 1 } });
  session.handleKey(0, false);
  assert.equal(engine.runtime.get(replacementId)!.n, 1, 'a moved action retains its original down/up pair');
  assert.equal(session.page()!.keys[1]!.id, replacementId);
});

test('removed delayed workflows cannot dispatch later children or recreate their runtime', async (t) => {
  const { session, engine, rpc } = await boot(t);
  const delay = newInstance('sd.delay', 'removed-workflow-delay');
  delay.settings.ms = 30;
  const child = newInstance('util.counter', 'removed-workflow-child');
  const base = { profileId: session.profileId, pageId: session.pageId, kind: 'key', index: 0 };
  const workflowId = await rpc['slots.assign']!({ ...base, type: 'sd.multi', configured: true, settings: { steps: [delay, child] } }) as string;
  session.handleKey(0, true);
  session.handleKey(0, false);
  await rpc['slots.assign']!({ ...base, type: 'util.counter' });
  await new Promise((resolve) => setTimeout(resolve, 70));
  assert.equal(engine.runtime.has(workflowId), false);
  assert.equal(engine.runtime.has(child.id), false, 'the deleted child stays pruned after the delay completes');
});

test('retained workflows and ordinary async action results continue across page navigation', async (t) => {
  const { session, engine, rpc, store } = await boot(t);
  const profile = store.profile(session.profileId)!;
  const mainId = session.pageId;
  const otherId = profile.pageOrder[1]!;
  const delay = newInstance('sd.delay', 'navigated-workflow-delay');
  delay.settings.ms = 25;
  const child = newInstance('util.counter', 'navigated-workflow-child');
  await rpc['slots.assign']!({ profileId: profile.id, pageId: mainId, kind: 'key', index: 0, type: 'sd.multi', configured: true, settings: { steps: [delay, child] } });
  session.handleKey(0, true);
  session.handleKey(0, false);
  session.setPage(otherId);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(engine.runtime.get(child.id)!.n, 1, 'a saved workflow continues after its page is hidden');

  let finish!: (result: { code: number; stdout: string; stderr: string }) => void;
  t.mock.method(engine.platform, 'runScript', () => new Promise((resolve) => { finish = resolve; }));
  const script = newInstance('system.script', 'navigated-async-script');
  script.settings.path = '/recording-platform-fixture';
  profile.pages[mainId]!.keys[0] = script;
  engine.configChanged();
  session.setPage(mainId);
  session.handleKey(0, true);
  session.handleKey(0, false);
  session.setPage(otherId);
  finish({ code: 0, stdout: 'completed after navigation\n', stderr: '' });
  await settle();
  assert.equal(engine.runtime.get(script.id)!.output, 'completed after navigation');
});

test('detaching during async initialization cannot start a disposed session timer', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'sdp-early-detach-'));
  const store = new Store(dir);
  store.config.settings.executeActions = false;
  const manager = new DeviceManager();
  const engine = new Engine(store, manager);
  let finishInitialization!: () => void;
  const original = StreamDeckDevice.prototype.setBrightness;
  t.mock.method(StreamDeckDevice.prototype, 'setBrightness', function (this: StreamDeckDevice, value: number) {
    if (this.serial === 'EARLY-DETACH') return new Promise<void>((resolve) => { finishInitialization = resolve; });
    return original.call(this, value);
  });
  t.after(async () => { await manager.stop(); store.flush(); rmSync(dir, { recursive: true, force: true }); });
  const dev = await manager.addSimulator('neo', { serial: 'EARLY-DETACH', pageLatencyMs: 0 });
  const session = engine.sessions.get(dev.id)!;
  await manager.removeSimulator(dev.id);
  finishInitialization();
  await settle();
  assert.equal(engine.sessions.has(dev.id), false);
  const lifecycle = session as unknown as { liveTimer: ReturnType<typeof setInterval> | null };
  assert.equal(lifecycle.liveTimer, null);
  session.start();
  assert.equal(lifecycle.liveTimer, null, 'a disposed session cannot be restarted');
});
