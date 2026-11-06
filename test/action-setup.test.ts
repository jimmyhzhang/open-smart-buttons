import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ACTION_MAP, CATALOG } from '../src/engine/actions.ts';
import { DeviceManager } from '../src/device/manager.ts';
import { Engine } from '../src/engine/engine.ts';
import { Store } from '../src/engine/store.ts';
import { DryRunPlatform } from '../src/engine/platform.ts';
import type { AgentLaunchOptions } from '../src/engine/agent-launcher.ts';
import type { ScriptCommandOptions } from '../src/engine/script-commands.ts';
import { createRpc } from '../src/server/rpc.ts';
import { actionSummary, validateActionSetup } from '../src/shared/action-setup.ts';
import { ACTION_CATEGORIES, ACTION_PRESETS, actionChoices, matchesAction } from '../src/shared/action-presets.ts';

class RecordingPlatform extends DryRunPlatform {
  readonly calls: unknown[][] = [];
  handoff: Promise<void> | undefined;
  constructor() { super('macos', () => {}); }
  override async launchAgent(options: AgentLaunchOptions) { this.calls.push(['agent', options]); await this.handoff; }
  override async runScript(options: ScriptCommandOptions) {
    this.calls.push(['script', options]);
    return { code: 0, stdout: 'first line\nsecond line\n', stderr: '' };
  }
  override async runShortcut(name: string) { this.calls.push(['shortcut', name]); }
  override async openUrl(url: string) { this.calls.push(['url', url]); }
}

async function boot(t: { after(fn: () => Promise<void>): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'sdp-action-setup-'));
  const scriptFile = join(dir, 'fixture.sh');
  writeFileSync(scriptFile, '#!/bin/sh\nprintf "%s" "$@"\n');
  chmodSync(scriptFile, 0o755);
  const store = new Store(dir);
  store.config.settings.executeActions = false;
  const manager = new DeviceManager();
  const engine = new Engine(store, manager);
  const platform = new RecordingPlatform();
  engine.platform = platform;
  const rpc = createRpc(engine);
  const dev = await manager.addSimulator('neo', { pageLatencyMs: 0 });
  const session = engine.sessions.get(dev.id)!;
  const base = { profileId: session.profileId, pageId: session.pageId, kind: 'key', index: 0, configured: true };
  t.after(async () => { await manager.stop(); store.flush(); rmSync(dir, { recursive: true, force: true }); });
  const assign = (type: string, settings: Record<string, unknown>, index = 0) => rpc['slots.assign']!({ ...base, type, settings, index, replaceFolder: true });
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
  const press = (index: number) => { session.handleKey(index, true); session.handleKey(index, false); };
  return { store, engine, platform, rpc, session, base, assign, press, settle, projectDir: dir, scriptFile };
}

test('setup validation catches missing required values and invalid deep links/session settings', () => {
  const validate = (type: string, settings: Record<string, unknown>) => {
    const meta = ACTION_MAP.get(type)!.meta;
    return validateActionSetup(meta, { ...meta.defaults, ...settings }, 'key');
  };
  for (const type of ['agent.codex', 'agent.claude', 'system.script', 'system.shortcut', 'system.raycast', 'system.asyar', 'system.open', 'system.text', 'system.command', 'system.hotkey']) {
    assert.ok(validate(type, {}).length, `${type} requires its key behavior to be configured`);
  }
  assert.ok(validate('system.website', { url: ' ' }).length, 'website cannot be explicitly cleared to a blank URL');
  assert.ok(validate('agent.codex', { cwd: process.cwd(), mode: 'continue', prompt: 'new task' }).length);
  assert.ok(validate('agent.claude', { cwd: process.cwd(), mode: 'invalid' }).length);
  assert.deepEqual(validate('agent.codex', { cwd: process.cwd(), mode: 'continue', prompt: '' }), []);
  for (const type of ['system.raycast', 'system.asyar']) {
    assert.ok(validate(type, { url: 'https://example.com' }).length);
    assert.ok(validate(type, { url: 'not a URL' }).length);
  }
  assert.deepEqual(validate('system.raycast', { url: 'raycast://extensions/author/extension/command?arguments=%7B%7D' }), []);
  assert.deepEqual(validate('system.raycast', { url: 'com.raycast://extensions/author/extension/command' }), []);
  assert.deepEqual(validate('system.asyar', { url: 'asyar://extensions/author/extension/command' }), []);
  assert.ok(validate('system.shortcut', { name: '--help' }).length);
  assert.equal(validateActionSetup(ACTION_MAP.get('system.command')!.meta, { left: 'fixture' }, 'dial').length, 0, 'key-only command requirement does not block a dial');
});

test('invalid configured assignments preserve the existing button and folder tree', async (t) => {
  const { rpc, store, base, projectDir } = await boot(t);
  for (const index of [0, 3]) {
    const before = structuredClone(store.config);
    for (const type of ['agent.codex', 'system.script', 'system.shortcut', 'system.raycast', 'system.hotkey']) {
      await assert.rejects(async () => rpc['slots.assign']!({ ...base, index, type, settings: {}, replaceFolder: true }));
      assert.deepEqual(store.config, before, `${type} must not replace the existing slot before setup succeeds`);
    }
    await assert.rejects(async () => rpc['slots.assign']!({
      ...base, index, type: 'agent.codex', settings: { cwd: join(projectDir, 'missing-project'), mode: 'new' }, replaceFolder: true,
    }), /does not exist or is not a folder/);
    assert.deepEqual(store.config, before, 'a missing project directory must preserve the button and folder contents');
  }
});

test('configured assignment rejects invalid kinds/indices without mutating the profile', async (t) => {
  const { rpc, store, base, projectDir } = await boot(t);
  const before = structuredClone(store.config);
  for (const patch of [{ kind: 'unknown' }, { index: -1 }, { index: 8 }, { index: 0.5 }, { index: '0' }]) {
    await assert.rejects(async () => rpc['slots.assign']!({ ...base, type: 'util.counter', settings: {}, ...patch }));
    assert.deepEqual(store.config, before);
  }
  for (const settings of [undefined, null, []]) {
    await assert.rejects(async () => rpc['slots.assign']!({ ...base, type: 'util.counter', settings }), /settings must be an object/);
    assert.deepEqual(store.config, before);
  }
  await assert.rejects(async () => rpc['slots.assign']!({ ...base, type: 'agent.codex', kind: 'dial', index: 0, settings: { cwd: projectDir } }));
  assert.deepEqual(store.config, before);
});

test('valid configured assignment saves all settings/look together and does not execute', async (t) => {
  const { rpc, session, platform, base, engine, projectDir } = await boot(t);
  const observed: unknown[] = [];
  engine.on('state', () => observed.push(structuredClone(session.page()!.keys[0])));
  const settings = { cwd: projectDir, mode: 'new', prompt: 'Review the changes' };
  const appearance = { title: 'Review', bg: '#123456' };
  const id = await rpc['slots.assign']!({ ...base, type: 'agent.codex', settings, appearance });
  assert.deepEqual(session.page()!.keys[0], { id, type: 'agent.codex', settings, appearance });
  assert.equal(observed.length, 1);
  assert.deepEqual(observed[0], session.page()!.keys[0]);
  assert.deepEqual(platform.calls, [], 'saving a button never launches the agent');
});

test('replacing a folder requires a flag and only then removes its old contents', async (t) => {
  const { rpc, session, store, base } = await boot(t);
  const oldFolder = session.page()!.keys[3]!;
  const folderId = String(oldFolder.settings.folderId);
  const before = structuredClone(store.config);
  const replacement = { ...base, index: 3, type: 'system.open', settings: { path: 'Notes' } };
  await assert.rejects(async () => rpc['slots.assign']!(replacement), /Confirm replacing the folder/);
  assert.deepEqual(store.config, before);
  await rpc['slots.assign']!({ ...replacement, replaceFolder: true });
  assert.equal(session.page()!.keys[3]!.type, 'system.open');
  assert.equal(store.profile(session.profileId)!.pages[folderId], undefined);
});

test('configured presets do not share nested mutable settings or look with saved buttons', async (t) => {
  const { rpc, session, base } = await boot(t);
  const choice = ACTION_PRESETS.find((preset) => preset.id === 'spotlight')!;
  const before = structuredClone(choice);
  const appearance = { ...choice.appearance, icon: { kind: 'lucide' as const, name: 'search' } };
  await rpc['slots.assign']!({ ...base, type: choice.type, settings: choice.settings, appearance });
  const saved = session.page()!.keys[0]!;
  assert.notEqual(saved.settings.hotkey, choice.settings.hotkey);
  assert.notEqual(saved.appearance.icon, appearance.icon);
  (saved.settings.hotkey as { key: string }).key = 'x';
  saved.appearance.title = 'Changed saved button';
  (saved.appearance.icon as { name: string }).name = 'changed';
  assert.equal(appearance.icon.name, 'search');
  assert.deepEqual(choice, before);
});

test('every preset maps to a real key action with coherent fields, select values and discovery metadata', () => {
  const ids = ACTION_PRESETS.map((choice) => choice.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const choice of ACTION_PRESETS) {
    const meta = ACTION_MAP.get(choice.type)!.meta;
    assert.ok(meta, `${choice.type} exists`);
    assert.ok(meta.controllers.includes('key'));
    assert.ok(ACTION_CATEGORIES.includes(choice.category));
    assert.ok(choice.name.trim() && choice.description.trim() && choice.icon.trim());
    assert.match(choice.color, /^#[\da-f]{6}$/i);
    for (const [name, value] of Object.entries(choice.settings)) {
      const field = meta.fields.find((item) => item.key === name);
      assert.ok(field, `${choice.id} uses the defined ${name} field`);
      if (field.type === 'select') assert.ok(field.options!.some((option) => option.value === value));
      if (field.type === 'hotkey') assert.ok(typeof (value as { key?: string })?.key === 'string');
    }
  }
  assert.equal(actionChoices(CATALOG).filter((choice) => choice.type === 'unsupported').length, 0);
  assert.ok(matchesAction(ACTION_PRESETS.find((choice) => choice.id === 'codex-review')!, 'CODEX review'));
  assert.equal(matchesAction(ACTION_PRESETS.find((choice) => choice.id === 'codex-review')!, 'codex missingword'), false);
  assert.ok(actionSummary(ACTION_MAP.get('agent.codex')!.meta, { cwd: process.cwd(), mode: 'continue' }).includes(process.cwd()));
  assert.match(actionSummary(ACTION_MAP.get('system.script')!.meta, { path: '/fixture.sh', arg1: 'input' }), /fixture\.sh.*arguments/);
});

test('new key actions route agent/script/shortcut/deep-link settings to the platform', async (t) => {
  const { assign, platform, press, settle, session, engine, projectDir, scriptFile } = await boot(t);
  const fixtures = [
    ['agent.codex', { cwd: projectDir, mode: 'new', prompt: '--literal prompt' }],
    ['agent.claude', { cwd: projectDir, mode: 'continue', prompt: '' }],
    ['system.script', { path: scriptFile, arg1: 'first', arg2: '', arg3: 'third', showOutput: true }],
    ['system.shortcut', { name: 'Focus time' }],
    ['system.raycast', { url: 'raycast://extensions/author/extension/command?x=%24literal' }],
    ['system.asyar', { url: 'asyar://extensions/author/extension/command' }],
  ] as const;
  for (const [index, [type, settings]] of fixtures.entries()) {
    await assign(type, settings, index);
    press(index);
    await settle();
  }
  assert.deepEqual(platform.calls, [
    ['agent', { tool: 'codex', cwd: projectDir, mode: 'new', prompt: '--literal prompt' }],
    ['agent', { tool: 'claude', cwd: projectDir, mode: 'continue', prompt: '' }],
    ['script', { path: scriptFile, args: ['first', '', 'third'] }],
    ['shortcut', 'Focus time'],
    ['url', 'raycast://extensions/author/extension/command?x=%24literal'],
    ['url', 'asyar://extensions/author/extension/command'],
  ]);
  assert.equal(engine.stateFor(session.page()!.keys[2]!.id).output, 'first line');
});

test('repeated agent presses are coalesced until Terminal handoff settles, then can launch again', async (t) => {
  const { assign, platform, press, settle, projectDir } = await boot(t);
  let finish!: () => void;
  platform.handoff = new Promise((resolve) => { finish = resolve; });
  await assign('agent.codex', { cwd: projectDir, mode: 'new', prompt: '' });
  press(0);
  press(0);
  await settle();
  assert.equal(platform.calls.length, 1);
  finish();
  await settle();
  press(0);
  await settle();
  assert.equal(platform.calls.length, 2);
});

test('dry-run key dispatch logs integrations without launching real tools or scripts', async (t) => {
  const { assign, engine, platform, press, settle, projectDir, scriptFile } = await boot(t);
  const logs: string[] = [];
  engine.platform = new DryRunPlatform('macos', (message) => logs.push(message));
  for (const [type, settings] of [
    ['agent.codex', { cwd: projectDir, prompt: '', mode: 'new' }],
    ['system.script', { path: scriptFile }],
    ['system.shortcut', { name: 'Fixture shortcut' }],
    ['system.raycast', { url: 'raycast://extensions/fixture/command' }],
  ] as const) {
    await assign(type, settings);
    press(0);
    await settle();
  }
  assert.equal(logs.length, 4);
  assert.deepEqual(platform.calls, []);
  assert.ok(logs.some((log) => log.startsWith('launch codex')));
  assert.ok(logs.some((log) => log.startsWith('script ')));
  assert.ok(logs.some((log) => log.startsWith('shortcut ')));
  assert.ok(logs.some((log) => log.includes('raycast://')));
});
