import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeviceManager } from '../src/device/manager.ts';
import { Engine } from '../src/engine/engine.ts';
import { Store } from '../src/engine/store.ts';
import { newInstance } from '../src/engine/actions.ts';
import { createRpc } from '../src/server/rpc.ts';
import type { ActionInstance, Profile } from '../src/shared/types.ts';

function actionIds(profile: Profile): string[] {
  const ids: string[] = [];
  const visit = (inst: ActionInstance) => {
    ids.push(inst.id);
    for (const step of (inst.settings.steps as ActionInstance[] | undefined) ?? []) visit(step);
  };
  for (const page of Object.values(profile.pages)) for (const inst of [...page.keys, ...page.dials]) if (inst) visit(inst);
  return ids;
}

async function boot(t: { after(fn: () => Promise<void>): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'osb-profile-isolation-'));
  const store = new Store(dir);
  store.config.settings.executeActions = false;
  const manager = new DeviceManager();
  const engine = new Engine(store, manager);
  const rpc = createRpc(engine);
  const dev = await manager.addSimulator('plus', { pageLatencyMs: 0 });
  const session = engine.sessions.get(dev.id)!;
  const source = store.profile(session.profileId)!;
  const main = source.pages[source.pageOrder[0]!]!;
  main.keys[0] = newInstance('util.counter', 'source-counter');
  main.keys[1] = newInstance('util.toggle', 'source-toggle');
  const multi = newInstance('sd.multi', 'source-multi');
  const nested = newInstance('sd.multi', 'nested-multi');
  nested.settings.steps = [newInstance('util.toggle', 'nested-toggle')];
  multi.settings.steps = [newInstance('util.counter', 'nested-counter'), nested];
  main.keys[2] = multi;
  t.after(async () => {
    await manager.stop();
    store.flush();
    rmSync(dir, { recursive: true, force: true });
  });
  const press = async (index: number) => {
    session.handleKey(index, true);
    session.handleKey(index, false);
    await new Promise<void>((resolve) => setImmediate(resolve));
  };
  return { engine, rpc, store, session, source, main, multi, press, dev };
}

test('duplicated profiles get independent counter/toggle state, including nested multi actions', async (t) => {
  const { engine, rpc, store, source, main, press, dev } = await boot(t);
  await press(0);
  await press(1);
  await press(2);
  const sourceIds = actionIds(source);
  const id = await rpc['profiles.duplicate']!({ profileId: source.id }) as string;
  const copy = store.profile(id)!;
  const copyIds = actionIds(copy);
  assert.equal(new Set(copyIds).size, copyIds.length, 'all copied action ids are unique');
  assert.ok(copyIds.every((actionId) => !sourceIds.includes(actionId)), 'no runtime state id is shared with the original');
  assert.deepEqual(copy.pageOrder, source.pageOrder, 'page ids stay profile scoped');
  assert.deepEqual(copy.pages[main.id]!.keys[3]!.settings, main.keys[3]!.settings, 'folder target is preserved');
  const folderId = String(main.keys[3]!.settings.folderId);
  assert.equal(copy.pages[folderId]!.parentId, main.id, 'folder ancestry is preserved');

  engine.setSessionProfile(dev.id, copy.id);
  await press(0);
  await press(1);
  await press(2);
  const copiedMain = copy.pages[main.id]!;
  assert.equal(engine.stateFor(copiedMain.keys[0]!.id).n, 1, 'copied counter starts fresh');
  assert.equal(engine.stateFor(copiedMain.keys[1]!.id).on, true, 'copied toggle starts off');
  assert.equal(engine.stateFor('source-counter').n, 1);
  assert.equal(engine.stateFor('source-toggle').on, true);
  const copiedSteps = copiedMain.keys[2]!.settings.steps as ActionInstance[];
  assert.equal(engine.stateFor(copiedSteps[0]!.id).n, 1);
  assert.equal(engine.stateFor(((copiedSteps[1]!.settings.steps as ActionInstance[])[0]!).id).on, true);
  assert.equal(engine.stateFor('nested-counter').n, 1);
  assert.equal(engine.stateFor('nested-toggle').on, true);
});

test('importing the same JSON profile twice assigns fresh action ids without changing its pages or source', async (t) => {
  const { rpc, store, source } = await boot(t);
  const data = structuredClone(source);
  const before = structuredClone(data);
  const firstId = await rpc['profiles.importJson']!({ data }) as string;
  const secondId = await rpc['profiles.importJson']!({ data }) as string;
  const first = store.profile(firstId)!;
  const second = store.profile(secondId)!;
  assert.deepEqual(data, before, 'import must not mutate the supplied profile');
  assert.notEqual(firstId, secondId);
  const originalIds = actionIds(source);
  const firstIds = actionIds(first);
  const secondIds = actionIds(second);
  assert.ok(firstIds.every((id) => !originalIds.includes(id)));
  assert.ok(secondIds.every((id) => !originalIds.includes(id) && !firstIds.includes(id)));
  assert.deepEqual(first.pageOrder, source.pageOrder);
  const sourceFolder = source.pages[source.pageOrder[0]!]!.keys[3]!;
  assert.deepEqual(first.pages[source.pageOrder[0]!]!.keys[3]!.settings, sourceFolder.settings);
});

test('pasting a multi action also gives its nested counter and toggle independent state', async (t) => {
  const { rpc, engine, source, main, multi, press } = await boot(t);
  await press(2);
  await rpc['slots.paste']!({ profileId: source.id, pageId: main.id, kind: 'key', index: 5, instance: multi });
  const pasted = main.keys[5]!;
  await press(5);
  const steps = pasted.settings.steps as ActionInstance[];
  assert.notEqual(pasted.id, multi.id);
  assert.notEqual(steps[0]!.id, 'nested-counter');
  assert.equal(engine.stateFor(steps[0]!.id).n, 1);
  const toggle = (steps[1]!.settings.steps as ActionInstance[])[0]!;
  assert.notEqual(toggle.id, 'nested-toggle');
  assert.equal(engine.stateFor(toggle.id).on, true);
  assert.equal(engine.stateFor('nested-counter').n, 1);
  assert.equal(engine.stateFor('nested-toggle').on, true);
});
