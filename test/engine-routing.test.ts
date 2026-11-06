import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeviceManager } from '../src/device/manager.ts';
import { SimulatedStreamDeck } from '../src/device/sim-transport.ts';
import { StreamDeckDevice } from '../src/device/streamdeck.ts';
import { Engine } from '../src/engine/engine.ts';
import { Store } from '../src/engine/store.ts';
import { DryRunPlatform, PermissionError, type MediaCmd } from '../src/engine/platform.ts';
import type { Hotkey } from '../src/shared/types.ts';
import { createRpc } from '../src/server/rpc.ts';

class RecordingPlatform extends DryRunPlatform {
  readonly calls: unknown[][] = [];
  blockMedia = false;
  constructor() { super('macos', () => {}); }
  override async media(command: MediaCmd) {
    if (this.blockMedia) throw new PermissionError('accessibility', 'Media keys need Accessibility permission');
    this.calls.push(['media', command]);
  }
  override async openPath(path: string) { this.calls.push(['open', path]); }
  override async openUrl(url: string) { this.calls.push(['website', url]); }
  override async hotkey(hotkey: Hotkey) { this.calls.push(['hotkey', hotkey]); }
  override async typeText(text: string, options: { enter?: boolean; paste?: boolean }) { this.calls.push(['text', text, options]); }
  override async run(command: string) {
    this.calls.push(['command', command]);
    return { code: 0, stdout: '', stderr: '' };
  }
}

async function bootNeo(t: { after(fn: () => Promise<void>): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'sdp-routing-'));
  const store = new Store(dir);
  // Never execute an OS operation, even if the test setup changes.
  store.config.settings.executeActions = false;
  const manager = new DeviceManager();
  const engine = new Engine(store, manager);
  const platform = new RecordingPlatform();
  engine.platform = platform;
  const dev = await manager.addSimulator('neo', { pageLatencyMs: 0 });
  const sim = manager.simFor(dev)!;
  const session = engine.sessions.get(dev.id)!;
  const rpc = createRpc(engine);
  t.after(async () => {
    await manager.stop();
    store.flush();
    rmSync(dir, { recursive: true, force: true });
  });
  // A literal Neo key-state report: 8 keys followed by its two touch points.
  // Keep this independent of the application's input encoder.
  const input = (index: number, down: boolean) => {
    const report = new Uint8Array([1, 0, 10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    if (down) report[4 + index] = 1;
    sim.inject(report);
  };
  const press = (index: number) => { input(index, true); input(index, false); };
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
  return { engine, platform, session, rpc, input, press, settle };
}

test('Neo HID keys 0–7 dispatch the configured macOS operation and settings exactly once', async (t) => {
  const { platform, session, rpc, input, press, settle } = await bootNeo(t);
  const hotkey = { key: 'Space', cmd: true };
  const assignments = [
    ['system.multimedia', { action: 'playpause' }],
    ['system.multimedia', { action: 'previous' }],
    ['system.multimedia', { action: 'next' }],
    ['system.open', { path: 'Safari' }],
    ['system.website', { url: 'example.com' }],
    ['system.hotkey', { hotkey }],
    ['system.text', { text: 'routing fixture', paste: true, enter: true }],
    ['system.command', { command: 'fixture-command' }],
  ] as const;
  for (const [index, [type, settings]] of assignments.entries()) {
    const base = { profileId: session.profileId, pageId: session.pageId, kind: 'key', index };
    await rpc['slots.assign']!({ ...base, type, replaceFolder: index === 3 });
    await rpc['slots.update']!({ ...base, settings });
  }
  // Repeated state reports while a key is held must not execute it again.
  input(0, true);
  input(0, true);
  input(0, false);
  for (let index = 1; index < 8; index++) press(index);
  await settle();
  assert.deepEqual(platform.calls, [
    ['media', 'playpause'],
    ['media', 'previous'],
    ['media', 'next'],
    ['open', 'Safari'],
    ['website', 'https://example.com'],
    ['hotkey', hotkey],
    ['text', 'routing fixture', { paste: true, enter: true }],
    ['command', 'fixture-command'],
  ]);
});

test('Neo starter folder/page navigation changes which operation a physical key invokes', async (t) => {
  const { platform, session, press, settle } = await bootNeo(t);
  const mainPage = session.pageId;
  press(3); // Apps folder.
  assert.notEqual(session.pageId, mainPage);
  press(1); // Safari, in the folder rather than Previous Track on Main.
  press(4); // Calculator.
  press(0); // Back to Main.
  assert.equal(session.pageId, mainPage);
  press(1);
  press(7); // Page 2.
  assert.notEqual(session.pageId, mainPage);
  press(1); // Screenshot shortcut.
  await settle();
  assert.deepEqual(platform.calls, [
    ['open', 'Safari'], ['open', 'Calculator'], ['media', 'previous'],
    ['hotkey', { key: '4', cmd: true, shift: true }],
  ]);
});

test('a blocked Neo operation emits permission/error feedback and later keys still work', async (t) => {
  const { engine, platform, press, settle } = await bootNeo(t);
  const permissions: unknown[][] = [];
  const errors: string[] = [];
  engine.on('permission', (...event) => permissions.push(event));
  engine.on('log', (level, message) => { if (level === 'error') errors.push(message); });
  platform.blockMedia = true;
  press(0);
  await settle();
  assert.deepEqual(permissions, [['accessibility', 'Media: Media keys need Accessibility permission']]);
  assert.deepEqual(errors, ['Media: Media keys need Accessibility permission']);
  press(4); // Website does not need Accessibility permission.
  await settle();
  assert.deepEqual(platform.calls, [['website', 'https://github.com']]);
});

test('strict simulator actions and state stay separate from a live USB session', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'sdp-isolated-platform-'));
  const store = new Store(dir, true);
  store.config.settings.executeActions = true;
  const manager = new DeviceManager();
  const engine = new Engine(store, manager, true);
  const mock = new DryRunPlatform('macos', () => {});
  const live = Object.assign(mock, { canExecute: true });
  const media = live.media.bind(live);
  let mediaCalls = 0;
  live.media = async (operation) => { mediaCalls++; return media(operation); };
  engine.platform = live;

  const sim = await manager.addSimulator('neo', { pageLatencyMs: 0 });
  const transport = new SimulatedStreamDeck(sim.model, { serial: 'USB-FIXTURE', pageLatencyMs: 0 });
  transport.info.kind = 'usb';
  const usb = new StreamDeckDevice(transport, sim.model);
  await usb.open();
  manager.emit('attach', usb);
  t.after(async () => { manager.emit('detach', usb); await usb.close(); await manager.stop(); store.flush(); rmSync(dir, { recursive: true, force: true }); });
  const simulated = engine.sessions.get(sim.id)!;
  const connected = engine.sessions.get(usb.id)!;
  assert.equal(simulated.profileId, connected.profileId);
  const key = simulated.page()!.keys[1]!;
  const usbBefore = await connected.platform.getVolume();
  await simulated.testPress({ kind: 'key', index: 1 });
  assert.equal(mediaCalls, 0);
  assert.deepEqual(await connected.platform.getVolume(), usbBefore);
  assert.notEqual(simulated.stateHub.values.get('volume'), usbBefore.volume);
  assert.notEqual(engine.stateFor(key.id, sim), engine.stateFor(key.id, usb));
  await connected.testPress({ kind: 'key', index: 1 });
  assert.equal(mediaCalls, 1);

  const rpc = createRpc(engine);
  await rpc['slots.assign']!({ profileId: simulated.profileId, pageId: simulated.pageId, kind: 'key', index: 6, type: 'system.command', configured: true, settings: { command: 'fixture' } });
  await assert.rejects(connected.testPress({ kind: 'key', index: 6 }), /local-only/);
  await simulated.testPress({ kind: 'key', index: 6 });
});
