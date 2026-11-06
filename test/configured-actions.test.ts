import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ACTION_MAP, newInstance } from '../src/engine/actions.ts';
import { Store, uid } from '../src/engine/store.ts';
import { Engine } from '../src/engine/engine.ts';
import { DeviceManager } from '../src/device/manager.ts';
import { createRpc } from '../src/server/rpc.ts';
import { validateActionSetup } from '../src/shared/action-setup.ts';
import type { ActionInstance } from '../src/shared/types.ts';

const resolveMeta = (type: string) => ACTION_MAP.get(type)?.meta;
const step = (type: string, settings: Record<string, unknown> = {}): ActionInstance => {
  const action = newInstance(type, uid());
  Object.assign(action.settings, settings);
  return action;
};
const validateMulti = (steps: unknown) => validateActionSetup(ACTION_MAP.get('sd.multi')!.meta, { steps }, 'key', resolveMeta);

async function setup(t: { after(fn: () => Promise<void>): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'sdp-configured-'));
  const store = new Store(dir);
  store.config.settings.executeActions = false;
  const manager = new DeviceManager();
  const engine = new Engine(store, manager);
  const dev = await manager.addSimulator('neo', { pageLatencyMs: 0 });
  const session = engine.sessions.get(dev.id)!;
  const rpc = createRpc(engine);
  const base = { profileId: session.profileId, pageId: session.pageId, kind: 'key', index: 0, configured: true };
  const assign = (steps: ActionInstance[], patch: Record<string, unknown> = {}) => rpc['slots.assign']!({ ...base, type: 'sd.multi', settings: { steps }, ...patch });
  const script = join(dir, 'fixture script.sh');
  writeFileSync(script, '#!/bin/sh\n# @raycast.argument1 {"type":"text","placeholder":"Input"}\nprintf "%s" "$1"\n');
  chmodSync(script, 0o755);
  t.after(async () => { await manager.stop(); store.flush(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, store, engine, rpc, session, base, assign, script };
}

test('recursive Multi Action validation rejects empty, invalid, unknown and non-executable steps', () => {
  for (const steps of [[], [step('sd.delay')], [step('util.clock')], [step('unsupported')], [step('sd.multi', { steps: [step('sd.delay')] })]]) {
    assert.ok(validateMulti(steps).length, 'a workflow needs an executable operation');
  }
  assert.match(validateMulti('not a list').join(' '), /must be a list/);
  assert.match(validateMulti([{ id: uid(), type: 'missing.action', settings: {}, appearance: {} }]).join(' '), /unknown action/);
  assert.match(validateMulti([step('system.text', { text: '' })]).join(' '), /Step 1: Text is required/);
  assert.match(validateMulti([step('sd.multi', { steps: [step('agent.codex', { cwd: '/project', mode: 'continue', prompt: 'new task' })] })]).join(' '), /Step 1: Step 1: Continue/);
  for (const ms of [-1, 60_001, '100', NaN, Infinity]) assert.ok(validateMulti([step('sd.delay', { ms }), step('util.counter')]).length);
  const valid = [step('sd.delay', { ms: 0 }), step('sd.multi', { steps: [step('system.text', { text: 'hello' })] })];
  assert.deepEqual(validateMulti(valid), []);
  const duplicate = step('util.counter');
  assert.match(validateMulti([duplicate, structuredClone(duplicate)]).join(' '), /unique action identifier/);
  const cyclic = step('sd.multi');
  (cyclic.settings.steps as ActionInstance[]).push(cyclic);
  assert.match(validateMulti([cyclic]).join(' '), /circular reference/);
});

test('synchronous nested failures preserve the current key and folder graph', async (t) => {
  const { dir, store, assign } = await setup(t);
  for (const index of [0, 3]) {
    const before = structuredClone(store.config);
    for (const steps of [
      [], [step('system.text', { text: '' })], [step('sd.delay', { ms: -1 })],
      [step('sd.multi', { steps: [step('agent.codex', { cwd: join(dir, 'missing'), mode: 'new' })] })],
    ]) {
      assert.throws(() => assign(steps, { index, replaceFolder: true }));
      assert.deepEqual(store.config, before);
    }
    const cyclic = step('sd.multi');
    (cyclic.settings.steps as ActionInstance[]).push(cyclic);
    assert.throws(() => assign([cyclic], { index, replaceFolder: true }), /circular reference/);
    assert.deepEqual(store.config, before);
  }
});

test('all nested script preflights finish before a configured save can replace a folder', async (t) => {
  const { store, assign, script, dir } = await setup(t);
  const before = structuredClone(store.config);
  const missingArgument = assign([step('sd.multi', { steps: [step('system.script', { path: script })] })], { index: 3, replaceFolder: true });
  assert.ok(missingArgument instanceof Promise);
  await assert.rejects(missingArgument, /Input.*required/);
  assert.deepEqual(store.config, before);
  await assert.rejects(async () => assign([
    step('system.script', { path: script, arg1: 'valid' }),
    step('sd.multi', { steps: [step('system.script', { path: join(dir, 'missing.sh') })] }),
  ], { index: 3, replaceFolder: true }), /not found/);
  assert.deepEqual(store.config, before, 'one failed nested script cannot commit earlier preflight results');
});

test('valid nested actions retain defaults and save atomically without running a script or agent', async (t) => {
  const { store, session, assign, script, dir, engine } = await setup(t);
  const logs: string[] = [];
  engine.on('log', (_level, message) => logs.push(message));
  const agent = step('agent.codex', { cwd: dir });
  delete agent.settings.mode;
  const steps = [step('sd.delay'), step('sd.multi', { steps: [agent, step('system.script', { path: script, arg1: 'raw input' })] })];
  const beforeId = session.page()!.keys[0]!.id;
  const changes: string[] = [];
  engine.on('state', () => changes.push(session.page()!.keys[0]!.id));
  const id = await assign(steps);
  assert.equal(typeof id, 'string');
  assert.notEqual(id, beforeId);
  assert.deepEqual(changes, [id]);
  const saved = store.profile(session.profileId)!.pages[session.pageId]!.keys[0]!;
  const savedSteps = saved.settings.steps as ActionInstance[];
  assert.equal(((savedSteps[1]!.settings.steps as ActionInstance[])[0]!).settings.mode, 'new');
  assert.equal(logs.some((line) => line.includes('[dry-run]')), false, 'configuration saves never invoke action behavior');
  const syncResult = assign([step('util.counter')]);
  assert.equal(typeof syncResult, 'string', 'assignments without script IO remain synchronous');
});

test('async preflight cannot overwrite a newer assignment or resurrect a deleted target page', async (t) => {
  const { store, rpc, base, session, assign, script } = await setup(t);
  const pending = assign([step('system.script', { path: script, arg1: 'input' })]);
  const replacementId = rpc['slots.assign']!({ ...base, type: 'util.counter', settings: {}, appearance: { title: 'Newer choice' } });
  await assert.rejects(async () => pending, /button changed while setup was being checked/);
  assert.equal(session.page()!.keys[0]!.id, replacementId);
  assert.equal(session.page()!.keys[0]!.appearance.title, 'Newer choice');
  const targetPage = store.profile(session.profileId)!.pageOrder[1]!;
  const pagePending = assign([step('system.script', { path: script, arg1: 'input' })], { pageId: targetPage });
  rpc['pages.delete']!({ profileId: base.profileId, pageId: targetPage });
  await assert.rejects(async () => pagePending, /No page/);
  assert.equal(store.profile(session.profileId)!.pages[targetPage], undefined);
});

test('clearing a folder requires an explicit deletion flag and pending saves cannot undo that deletion', async (t) => {
  const { rpc, base, store, session, assign, script } = await setup(t);
  const folderId = String(session.page()!.keys[3]!.settings.folderId);
  const before = structuredClone(store.config);
  assert.throws(() => rpc['slots.clear']!({ ...base, index: 3 }), /Confirm deleting this folder and its contents/);
  assert.deepEqual(store.config, before);
  const pending = assign([step('system.script', { path: script, arg1: 'input' })], { index: 3, replaceFolder: true });
  rpc['slots.clear']!({ ...base, index: 3, deleteFolder: true });
  await assert.rejects(async () => pending, /button changed/);
  assert.equal(session.page()!.keys[3], null);
  assert.equal(store.profile(session.profileId)!.pages[folderId], undefined);
});

test('settings updates preserve instance identity and runtime while appearance-only autosaves stay synchronous', async (t) => {
  const { rpc, base, session, engine } = await setup(t);
  const id = rpc['slots.assign']!({ ...base, type: 'util.counter', settings: {} }) as string;
  const runtime = engine.stateFor(id);
  runtime.n = 12;
  const result = rpc['slots.update']!({ ...base, expectedActionId: id, settings: { step: 3 }, appearance: { title: 'Updated counter' } });
  assert.equal(result, undefined, 'settings without script IO remain synchronous');
  assert.equal(session.page()!.keys[0]!.id, id);
  assert.equal(session.page()!.keys[0]!.settings.step, 3);
  assert.equal(session.page()!.keys[0]!.appearance.title, 'Updated counter');
  assert.equal(engine.stateFor(id), runtime);
  assert.equal(runtime.n, 12);
  assert.throws(() => rpc['slots.update']!({ ...base, expectedActionId: 'stale-action', settings: { step: 4 } }), /button changed/);
  const legacyId = rpc['slots.assign']!({ ...base, type: 'system.text', configured: false }) as string;
  assert.equal(rpc['slots.update']!({ ...base, expectedActionId: legacyId, appearance: { title: 'Legacy label', icon: null } }), undefined);
  assert.equal(session.page()!.keys[0]!.appearance.title, 'Legacy label');
  assert.equal(session.page()!.keys[0]!.appearance.icon, undefined);
});

test('invalid settings updates preserve all old settings and look, including nested and password scripts', async (t) => {
  const { rpc, base, session, store, dir, script, assign } = await setup(t);
  rpc['slots.assign']!({ ...base, type: 'agent.codex', settings: { cwd: dir, mode: 'new', prompt: '' } });
  let before = structuredClone(store.config);
  for (const settings of [{ cwd: join(dir, 'missing') }, { mode: 'continue', prompt: 'new task' }, null, []]) {
    assert.throws(() => rpc['slots.update']!({ ...base, settings, appearance: { title: 'Must not save' } }));
    assert.deepEqual(store.config, before);
  }
  await assign([step('util.counter')]);
  before = structuredClone(store.config);
  assert.throws(() => rpc['slots.update']!({ ...base, settings: { steps: [step('sd.delay')] } }), /executable action/);
  assert.deepEqual(store.config, before);
  await rpc['slots.assign']!({ ...base, type: 'system.script', settings: { path: script, arg1: 'original' } });
  before = structuredClone(store.config);
  await assert.rejects(async () => rpc['slots.update']!({ ...base, settings: { arg1: '' }, appearance: { title: 'Must not save' } }), /Input.*required/);
  assert.deepEqual(store.config, before);
  const passwordScript = join(dir, 'interactive.sh');
  writeFileSync(passwordScript, '#!/bin/sh\n# @raycast.argument1 {"type":"password","placeholder":"Credential","optional":true}\nprintf "%s" "$1"\n');
  chmodSync(passwordScript, 0o755);
  await assert.rejects(async () => rpc['slots.update']!({ ...base, settings: { path: passwordScript, arg1: 'fixture-private-input' } }), /Run it interactively/);
  assert.deepEqual(store.config, before);
  assert.equal(JSON.stringify(store.config).includes('fixture-private-input'), false);
  assert.equal(session.page()!.keys[0]!.settings.arg1, 'original');
});

test('async script updates preserve unrelated appearance autosaves and reject replacement actions', async (t) => {
  const { rpc, base, session, script } = await setup(t);
  const id = await rpc['slots.assign']!({ ...base, type: 'system.script', settings: { path: script, arg1: 'original' } });
  const pending = rpc['slots.update']!({ ...base, expectedActionId: id, settings: { arg1: 'new input' } });
  assert.ok(pending instanceof Promise);
  rpc['slots.update']!({ ...base, expectedActionId: id, appearance: { title: 'Concurrent look' } });
  await pending;
  assert.equal(session.page()!.keys[0]!.id, id);
  assert.equal(session.page()!.keys[0]!.settings.arg1, 'new input');
  assert.equal(session.page()!.keys[0]!.appearance.title, 'Concurrent look');
  const stale = rpc['slots.update']!({ ...base, expectedActionId: id, settings: { arg1: 'outdated input' }, appearance: { title: 'Outdated look' } });
  const replacementId = rpc['slots.assign']!({ ...base, type: 'util.counter', settings: {}, appearance: { title: 'Replacement' } });
  await assert.rejects(async () => stale, /button changed while setup was being checked/);
  assert.equal(session.page()!.keys[0]!.id, replacementId);
  assert.equal(session.page()!.keys[0]!.appearance.title, 'Replacement');
});

test('competing asynchronous settings saves cannot overwrite a newer settings object on the same instance', async (t) => {
  const { rpc, base, session, script } = await setup(t);
  const id = await rpc['slots.assign']!({ ...base, type: 'system.script', settings: { path: script, arg1: 'original' } });
  const first = rpc['slots.update']!({ ...base, expectedActionId: id, settings: { arg1: 'first' } });
  const second = rpc['slots.update']!({ ...base, expectedActionId: id, settings: { arg1: 'second' } });
  const outcomes = await Promise.allSettled([first, second]);
  assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
  const rejected = outcomes.find((outcome) => outcome.status === 'rejected') as PromiseRejectedResult;
  assert.match(rejected.reason.message, /action settings changed while setup was being checked/);
  assert.equal(session.page()!.keys[0]!.id, id);
  assert.ok(['first', 'second'].includes(String(session.page()!.keys[0]!.settings.arg1)));
});

test('nested folders require an existing target while a top-level Folder still creates its own page', async (t) => {
  const { rpc, base, session, store, assign } = await setup(t);
  assert.match(validateMulti([step('sd.folder')]).join(' '), /choose an existing folder/);
  const before = structuredClone(store.config);
  assert.throws(() => assign([step('sd.folder', { folderId: 'missing-folder' })]), /folder selected.*no longer exists/);
  assert.deepEqual(store.config, before);
  const existingFolder = String(session.page()!.keys[3]!.settings.folderId);
  const pageCount = Object.keys(store.profile(session.profileId)!.pages).length;
  assign([step('sd.folder', { folderId: existingFolder })]);
  assert.equal(Object.keys(store.profile(session.profileId)!.pages).length, pageCount);
  rpc['slots.assign']!({ ...base, index: 7, type: 'sd.folder', settings: {} });
  const newFolder = String(session.page()!.keys[7]!.settings.folderId);
  assert.ok(store.profile(session.profileId)!.pages[newFolder]);
  assert.notEqual(newFolder, existingFolder);
});

test('a configured replacement cannot overwrite an action different from the one reviewed', async t => {
  const { rpc, base, store } = await setup(t);
  const id = rpc['slots.assign']!({ ...base, type: 'util.counter', settings: {} });
  assert.throws(() => rpc['slots.assign']!({
    ...base, type: 'util.clock', settings: {}, expectedActionId: 'outdated-action',
  }), /key changed/);
  assert.equal(store.profile(base.profileId)!.pages[base.pageId]!.keys[0]?.id, id);
});
