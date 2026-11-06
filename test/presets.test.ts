import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeviceManager } from '../src/device/manager.ts';
import { Engine } from '../src/engine/engine.ts';
import { Store } from '../src/engine/store.ts';
import { DryRunPlatform, MAC_CONTROLS, MacPlatform, type MacControlOp } from '../src/engine/platform.ts';
import { CATALOG, expandTextTokens } from '../src/engine/actions.ts';
import { createRpc } from '../src/server/rpc.ts';
import { ACTION_CATEGORIES, ACTION_PRESETS, actionChoices, actionScore, matchesAction } from '../src/shared/action-presets.ts';
import { validateActionSetup } from '../src/shared/action-setup.ts';
import { encodeKeysInput } from '../src/protocol/reports.ts';

class Recording extends DryRunPlatform {
  readonly calls: unknown[][] = [];
  awakeState = false;
  constructor() { super('macos', () => {}); }
  override async macControl(op: MacControlOp) { this.calls.push(['mac', op]); }
  override async keepAwake(on: boolean) { this.awakeState = on; this.calls.push(['awake', on]); return super.keepAwake(on); }
  override async typeText(text: string) { this.calls.push(['text', text]); }
  override async media(cmd: Parameters<DryRunPlatform['media']>[0]) { this.calls.push(['media', cmd]); }
  override async hotkey(h: Parameters<DryRunPlatform['hotkey']>[0]) { this.calls.push(['hotkey', h.key, !!h.ctrl]); }
  async readClipboard() { return 'CLIP'; }
}

test('preset library covers every category with a broad, unique, searchable set', () => {
  const ids = ACTION_PRESETS.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ACTION_PRESETS.length >= 80, `only ${ACTION_PRESETS.length} presets`);
  for (const cat of ACTION_CATEGORIES) {
    const n = actionChoices(CATALOG).filter((c) => c.category === cat).length;
    assert.ok(n >= 3, `${cat} has ${n} choices`);
  }
  const find = (q: string) => actionChoices(CATALOG).filter((c) => matchesAction(c, q)).sort((a, b) => actionScore(b, q) - actionScore(a, q))[0]?.id;
  assert.equal(find('dark'), 'mac-darkmode');
  assert.equal(find('zoom mute'), 'zoom-mute');
  assert.equal(find('lock'), 'mac-lock');
  assert.equal(find('caffeinate'), 'mac-awake');
  assert.equal(find('gmail'), 'site-gmail');
});

test('presets that need no input validate as-is; review presets are flagged', () => {
  const byType = new Map(CATALOG.map((m) => [m.type, m]));
  const ready = ACTION_PRESETS.filter((p) => !p.review && validateActionSetup(byType.get(p.type)!, { ...byType.get(p.type)!.defaults, ...p.settings }, 'key', (t) => byType.get(t)).length === 0);
  assert.ok(ready.length >= 50, `only ${ready.length} one-step presets`);
  for (const id of ['mac-darkmode', 'zoom-mute', 'site-gmail', 'open-app-0', 'snip-date', 'media-playpause']) assert.ok(ready.some((p) => p.id === id), id);
  for (const id of ['codex-review', 'snip-email', 'site-custom', 'auto-shortcut']) assert.ok(!ready.some((p) => p.id === id), `${id} needs input`);
});

test('Mac Control validates its operation and Keep Awake toggles through the platform', async (t) => {
  const meta = CATALOG.find((m) => m.type === 'system.mac')!;
  assert.deepEqual(validateActionSetup(meta, { op: 'darkmode' }, 'key'), []);
  assert.ok(validateActionSetup(meta, { op: 'rm -rf' }, 'key').length);
  const dir = mkdtempSync(join(tmpdir(), 'sdp-presets-'));
  const store = new Store(dir);
  store.config.settings.executeActions = false;
  const manager = new DeviceManager();
  const engine = new Engine(store, manager);
  const platform = new Recording();
  engine.platform = platform;
  const dev = await manager.addSimulator('neo', { pageLatencyMs: 0 });
  t.after(async () => {
    await manager.stop();
    store.flush();
    rmSync(dir, { recursive: true, force: true });
  });
  const session = engine.sessions.get(dev.id)!;
  const rpc = createRpc(engine);
  const base = { profileId: session.profileId, pageId: session.pageId, kind: 'key', configured: true };
  await rpc['slots.assign']!({ ...base, index: 0, type: 'system.mac', settings: { op: 'lock' } });
  await rpc['slots.assign']!({ ...base, index: 1, type: 'util.awake', settings: {} });
  await rpc['slots.assign']!({ ...base, index: 2, type: 'system.text', settings: { text: 'on {isodate}: {clipboard}', paste: true } });
  const sim = manager.simFor(dev)!;
  const press = async (k: number) => {
    const s = new Array(10).fill(false);
    s[k] = true;
    sim.inject(encodeKeysInput(s));
    sim.inject(encodeKeysInput(new Array(10).fill(false)));
    await new Promise((r) => setTimeout(r, 20));
  };
  await press(0);
  await press(1);
  await press(1);
  await press(2);
  const iso = new Date().toISOString().slice(0, 10);
  assert.deepEqual(platform.calls.slice(0, 3), [['mac', 'lock'], ['awake', true], ['awake', false]]);
  assert.equal((platform.calls[3] as string[])[1]!.replace(/\d{4}-\d\d-\d\d/, iso), `on ${iso}: CLIP`);
});

test('text tokens expand once and leave unknown braces alone', async () => {
  const p = new Recording();
  const d = new Date(2026, 10, 3, 9, 5);
  assert.equal(await expandTextTokens('{isodate} {nope} {{isodate}}', p, d), '2026-11-03 {nope} {2026-11-03}');
  assert.equal(await expandTextTokens('plain', p, d), 'plain');
});

test('every Mac control has a concrete macOS implementation', async () => {
  const calls: string[][] = [];
  const mac = new MacPlatform(async (cmd, args) => {
    calls.push([cmd, ...args]);
    // Report Accessibility as granted so keyboard-backed controls proceed.
    if (cmd === 'osascript' && args.join(' ').includes('AXIsProcessTrusted')) return { code: 0, stdout: 'true\n', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  });
  for (const { value } of MAC_CONTROLS) {
    const before = calls.length;
    await mac.macControl(value);
    assert.ok(calls.length > before, `${value} ran something`);
  }
  assert.ok(calls.some((c) => c[0] === '/usr/bin/pmset' && c[1] === 'displaysleepnow'));
  assert.ok(calls.some((c) => c.join(' ').includes('set dark mode to not dark mode')));
});

test('starter layouts only use one-step presets and fill empty slots on a Neo', async (t) => {
  const { STARTER_LAYOUTS } = await import('../src/shared/starter-layouts.ts');
  const choices = actionChoices(CATALOG);
  const byType = new Map(CATALOG.map((m) => [m.type, m]));
  for (const layout of STARTER_LAYOUTS) {
    for (const [kind, ids] of [['key', layout.keys], ['dial', layout.dials ?? []]] as const) {
      for (const id of ids) {
        const choice = choices.find((c) => c.id === id);
        assert.ok(choice, `${layout.id}: ${id} exists`);
        const meta = byType.get(choice.type)!;
        const settings = { ...meta.defaults, ...choice.settings };
        assert.ok(!choice.review && meta.controllers.includes(kind) && validateActionSetup(meta, settings, kind, (x) => byType.get(x)).length === 0, `${layout.id}: ${id} is one-step on a ${kind}`);
      }
    }
    assert.ok(layout.keys.length >= 8, `${layout.id} fills a Neo`);
  }
  const dir = mkdtempSync(join(tmpdir(), 'sdp-starter-'));
  const store = new Store(dir);
  store.config.settings.executeActions = false;
  const manager = new DeviceManager();
  const engine = new Engine(store, manager);
  engine.platform = new Recording();
  const dev = await manager.addSimulator('neo', { pageLatencyMs: 0 });
  t.after(async () => { await manager.stop(); store.flush(); rmSync(dir, { recursive: true, force: true }); });
  const session = engine.sessions.get(dev.id)!;
  const rpc = createRpc(engine);
  const pageId = await rpc['pages.addStarter']!({ profileId: session.profileId, deviceId: dev.id, layoutId: 'meetings' }) as string;
  const prof = store.config.profiles.find((p) => p.id === session.profileId)!;
  assert.equal(session.pageId, pageId);
  assert.equal(prof.pages[pageId]!.name, 'Meetings');
  assert.deepEqual(prof.pages[pageId]!.keys.map((k) => k?.appearance.title), ['Mute', 'Camera', 'Share', 'Hand', 'Zoom', 'Calendar', 'Volume', 'Awake']);
  // Filling an occupied page only touches its empty slots.
  const keep = prof.pages[pageId]!.keys[0]!.id;
  await rpc['slots.clear']!({ profileId: session.profileId, pageId, kind: 'key', index: 3 });
  const r = await rpc['pages.fillStarter']!({ profileId: session.profileId, pageId, layoutId: 'media' }) as { added: { index: number }[] };
  assert.deepEqual(r.added.map((a) => a.index), [3]);
  assert.equal(prof.pages[pageId]!.keys[0]!.id, keep);
  assert.equal(prof.pages[pageId]!.keys[3]!.appearance.title, 'Prev');
});

test('Neo touch points follow the profile setting and the info bar can switch modes', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'sdp-neo-tp-'));
  const store = new Store(dir);
  store.config.settings.executeActions = false;
  const manager = new DeviceManager();
  const engine = new Engine(store, manager);
  const platform = new Recording();
  engine.platform = platform;
  const dev = await manager.addSimulator('neo', { pageLatencyMs: 0 });
  t.after(async () => { await manager.stop(); store.flush(); rmSync(dir, { recursive: true, force: true }); });
  const session = engine.sessions.get(dev.id)!;
  const rpc = createRpc(engine);
  const sim = manager.simFor(dev)!;
  const touch = async (i: number) => {
    const s = new Array(10).fill(false);
    s[8 + i] = true;
    sim.inject(encodeKeysInput(s));
    sim.inject(encodeKeysInput(new Array(10).fill(false)));
    await new Promise((r) => setTimeout(r, 20));
  };
  const first = session.pageId;
  await touch(1);
  assert.notEqual(session.pageId, first, 'default: right touch point = next page');
  await rpc['profiles.setNeo']!({ profileId: session.profileId, touchPoints: 'media' });
  await touch(0);
  await rpc['profiles.setNeo']!({ profileId: session.profileId, touchPoints: 'volume' });
  await touch(1);
  await rpc['profiles.setNeo']!({ profileId: session.profileId, touchPoints: 'spaces' });
  await touch(0);
  await rpc['profiles.setNeo']!({ profileId: session.profileId, touchPoints: 'bogus', infoBar: 'page' });
  const prof = store.config.profiles.find((p) => p.id === session.profileId)!;
  assert.deepEqual(prof.neo, { touchPoints: 'pages', infoBar: 'page' });
  assert.deepEqual(platform.calls, [['media', 'previous'], ['media', 'volup'], ['hotkey', 'Left', true]]);
});

test('review fixes: one-click guards, dial hotkeys, generic actions, starter commits only new buttons', async (t) => {
  const { isOneStepChoice } = await import('../src/shared/action-presets.ts');
  const choices = actionChoices(CATALOG);
  const byType = new Map(CATALOG.map((m) => [m.type, m]));
  const one = (id: string, kind: 'key' | 'dial') => { const c = choices.find((x) => x.id === id)!; return isOneStepChoice(c, byType.get(c.type)!, kind, (x) => byType.get(x)); };
  assert.equal(one('copy', 'key'), true);
  assert.equal(one('copy', 'dial'), false, 'a hotkey preset has nothing to do on a dial');
  assert.equal(one('system.hotkey', 'dial'), false);
  assert.equal(one('system.website', 'key'), false, 'plain Website would land with a placeholder URL');
  assert.equal(one('util.toggle', 'key'), false);
  assert.equal(one('sd.folder', 'key'), true);

  const dir = mkdtempSync(join(tmpdir(), 'sdp-review-'));
  const store = new Store(dir);
  store.config.settings.executeActions = false;
  const manager = new DeviceManager();
  const engine = new Engine(store, manager);
  engine.platform = new Recording();
  const dev = await manager.addSimulator('neo', { pageLatencyMs: 0 });
  t.after(async () => { await manager.stop(); store.flush(); rmSync(dir, { recursive: true, force: true }); });
  const session = engine.sessions.get(dev.id)!;
  const rpc = createRpc(engine);
  const prof = store.config.profiles.find((p) => p.id === session.profileId)!;
  const pageId = session.pageId;
  const pg = prof.pages[pageId]!;
  const occupied = pg.keys.findIndex((k) => k);
  const before = pg.keys[occupied]!.id;
  await assert.rejects(async () => rpc['slots.assign']!({ profileId: prof.id, pageId, kind: 'key', index: occupied, type: 'util.clock', settings: {}, configured: true, expectEmpty: true }), /just filled/);
  assert.equal(pg.keys[occupied]!.id, before);

  // A button deleted during a fill stays deleted; existing buttons are never duplicated.
  const ids = pg.keys.filter(Boolean).map((k) => k!.id);
  const r = await rpc['pages.fillStarter']!({ profileId: prof.id, pageId, layoutId: 'everyday' }) as { added: { index: number; id: string }[] };
  const after = pg.keys.filter(Boolean).map((k) => k!.id);
  assert.equal(new Set(after).size, after.length, 'no duplicate ids');
  assert.deepEqual(after.filter((id) => !ids.includes(id)).sort(), r.added.map((a) => a.id).sort());
  for (const id of ids) assert.equal(after.filter((x) => x === id).length, 1);
});

test('Keep Awake state is shared across buttons and platform instances', async () => {
  const a = new DryRunPlatform('macos', () => {});
  const b = new DryRunPlatform('macos', () => {});
  await a.keepAwake(true);
  assert.equal(b.isAwake(), true, 'a new platform (e.g. after toggling dry run) sees the same state');
  await b.keepAwake(false);
  assert.equal(a.isAwake(), false);
});

test('pressing a button with an empty required setting explains instead of failing silently', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'sdp-unset-'));
  const store = new Store(dir);
  store.config.settings.executeActions = false;
  const manager = new DeviceManager();
  const engine = new Engine(store, manager);
  const platform = new Recording();
  let opened = 0;
  platform.openPath = async () => { opened++; };
  engine.platform = platform;
  const logs: string[] = [];
  engine.on('log', (_level: string, msg: string) => logs.push(msg));
  const dev = await manager.addSimulator('neo', { pageLatencyMs: 0 });
  t.after(async () => { await manager.stop(); store.flush(); rmSync(dir, { recursive: true, force: true }); });
  const session = engine.sessions.get(dev.id)!;
  const rpc = createRpc(engine);
  await rpc['slots.assign']!({ profileId: session.profileId, pageId: session.pageId, kind: 'key', index: 6, type: 'system.open' });
  const s = new Array(10).fill(false); s[6] = true;
  manager.simFor(dev)!.inject(encodeKeysInput(s));
  manager.simFor(dev)!.inject(encodeKeysInput(new Array(10).fill(false)));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(opened, 0);
  assert.ok(logs.some((l) => l.includes("Key 7 isn't set up yet")), logs.join('\n'));
  const meta = CATALOG.find((m) => m.type === 'system.open')!;
  assert.ok(validateActionSetup(meta, { path: '' }, 'key').length, 'setup refuses an empty Open');
});

test('an unset key reports once per press; strict mode is opt-in and reports once', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'sdp-once-'));
  const store = new Store(dir);
  store.config.settings.executeActions = false;
  const manager = new DeviceManager();
  const strict = new Engine(store, manager, true);
  assert.equal(new Engine(new Store(mkdtempSync(join(tmpdir(), 'sdp-default-'))), new DeviceManager()).localOnly, false, 'every action runs by default');
  const platform = new Recording();
  Object.defineProperty(platform, 'canExecute', { value: true });
  const urls: string[] = [];
  platform.openUrl = async (url: string) => { urls.push(url); };
  strict.platform = platform;
  const logs: string[] = [];
  strict.on('log', (_level: string, msg: string) => logs.push(msg));
  const dev = await manager.addSimulator('neo', { pageLatencyMs: 0 });
  t.after(async () => { await manager.stop(); store.flush(); rmSync(dir, { recursive: true, force: true }); });
  const session = strict.sessions.get(dev.id)!;
  const rpc = createRpc(strict);
  const press = async (index: number) => {
    const s = new Array(10).fill(false); s[index] = true;
    manager.simFor(dev)!.inject(encodeKeysInput(s));
    manager.simFor(dev)!.inject(encodeKeysInput(new Array(10).fill(false)));
    await new Promise((r) => setTimeout(r, 30));
  };
  await rpc['slots.assign']!({ profileId: session.profileId, pageId: session.pageId, kind: 'key', index: 6, type: 'system.open' });
  await press(6);
  assert.equal(logs.filter((l) => l.includes("isn't set up yet")).length, 1, logs.join('\n'));
  assert.ok(!logs.some((l) => l.includes('local-only')), 'an unset key never reaches the policy check');
  logs.length = 0;
  // Simulated decks are isolated from the Mac, so drive the strict check on the real-platform path.
  (strict as unknown as { isolateSimulators: boolean }).isolateSimulators = false;
  await rpc['slots.assign']!({ profileId: session.profileId, pageId: session.pageId, kind: 'key', index: 5, type: 'system.website', settings: { url: 'https://example.com' } });
  await press(5);
  assert.equal(logs.filter((l) => l.includes('local-only')).length, 1, logs.join('\n'));
  assert.deepEqual(urls, []);
});

test('a failing multi-action step is reported but the remaining steps still run', async () => {
  const { ACTION_MAP } = await import('../src/engine/actions.ts');
  const ran: string[] = [];
  const steps = [
    { id: 'a', type: 'system.command', settings: { command: 'pkill -x NotRunning' }, appearance: {} },
    { id: 'b', type: 'system.website', settings: { url: 'https://example.com' }, appearance: {} },
  ];
  const c = {
    settings: { steps }, state: {}, showOk() { ran.push('ok'); }, showAlert() {},
    runInstance: async (s: { id: string }) => { ran.push(s.id); if (s.id === 'a') throw new Error('The command exited with code 1'); },
  };
  await assert.rejects(async () => ACTION_MAP.get('sd.multi')!.keyDown!(c as never), /step 1 \(Run Command\): The command exited with code 1/);
  assert.deepEqual(ran, ['a', 'b']);
});

test('only real Accessibility errors become permission prompts', async () => {
  const { MacPlatform, PermissionError } = await import('../src/engine/platform.ts');
  const p = new MacPlatform(async () => ({ code: 1, stdout: '', stderr: 'The file /Users/u/ticket-1002 does not exist.' }));
  await assert.rejects(p.openPath('/Users/u/ticket-1002'), (e: Error) => !(e instanceof PermissionError) && /doesn't exist/.test(e.message));
});
