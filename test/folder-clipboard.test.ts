import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, emptyPage, uid } from '../src/engine/store.ts';
import { newInstance } from '../src/engine/actions.ts';
import { DeviceManager } from '../src/device/manager.ts';
import { Engine } from '../src/engine/engine.ts';
import { createRpc } from '../src/server/rpc.ts';
import { copyActionClipboard } from '../src/shared/action-clipboard.ts';
import type { ActionInstance, Page } from '../src/shared/types.ts';

function ids(instance: ActionInstance, pages: Record<string, Page>): string[] {
  const result: string[] = [];
  const visit = (action: ActionInstance) => {
    result.push(action.id);
    if (Array.isArray(action.settings.steps)) for (const child of action.settings.steps) visit(child as ActionInstance);
  };
  visit(instance);
  for (const page of Object.values(pages)) for (const action of [...page.keys, ...page.dials]) if (action) visit(action);
  return result;
}

async function setup(t: { after(fn: () => Promise<void>): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'sdp-folder-clipboard-'));
  const store = new Store(dir);
  store.config.settings.executeActions = false;
  const manager = new DeviceManager();
  const engine = new Engine(store, manager);
  const dev = await manager.addSimulator('neo', { pageLatencyMs: 0 });
  const session = engine.sessions.get(dev.id)!;
  const profile = store.profile(session.profileId)!;
  const main = profile.pages[session.pageId]!;
  const folder = main.keys[3]!;
  const folderPage = profile.pages[String(folder.settings.folderId)]!;
  const nestedPage = emptyPage('neo', 'Nested folder', folderPage.id);
  const nestedFolder = newInstance('sd.folder', uid());
  nestedFolder.settings.folderId = nestedPage.id;
  folderPage.keys[1] = newInstance('util.counter', uid());
  folderPage.keys[2] = nestedFolder;
  nestedPage.keys[0] = newInstance('sd.back', uid());
  nestedPage.keys[1] = newInstance('util.counter', uid());
  const multi = newInstance('sd.multi', uid());
  multi.settings.steps = [newInstance('util.counter', uid()), newInstance('util.toggle', uid())];
  nestedPage.keys[2] = multi;
  const toChild = newInstance('sd.page.goto', uid());
  toChild.settings.pageId = nestedPage.id;
  folderPage.keys[4] = toChild;
  const toParent = newInstance('sd.page.goto', uid());
  toParent.settings.pageId = folderPage.id;
  nestedPage.keys[3] = toParent;
  const external = newInstance('sd.page.goto', uid());
  external.settings.pageId = main.id;
  folderPage.keys[5] = external;
  profile.pages[nestedPage.id] = nestedPage;
  const rpc = createRpc(engine);
  t.after(async () => { await manager.stop(); store.flush(); rmSync(dir, { recursive: true, force: true }); });
  const base = { profileId: profile.id, pageId: main.id, kind: 'key', index: 0 };
  const press = (key: number) => { session.handleKey(key, true); session.handleKey(key, false); };
  return { store, manager, engine, rpc, dev, session, profile, main, folder, folderPage, nestedPage, base, press };
}

test('folder clipboard snapshots its reachable tree and still pastes after the original is cut', async (t) => {
  const { rpc, profile, main, folder, folderPage, nestedPage, base, engine } = await setup(t);
  const clipboard = copyActionClipboard(folder, profile.pages);
  assert.deepEqual(Object.keys(clipboard.folderPages!).sort(), [folderPage.id, nestedPage.id].sort());
  const oldIds = ids(clipboard.instance, clipboard.folderPages!);
  folder.appearance.title = 'Changed after copying';
  assert.notEqual(clipboard.instance.appearance.title, folder.appearance.title);
  engine.stateFor(folderPage.keys[1]!.id).n = 9;
  rpc['slots.clear']!({ ...base, index: 3, expectedActionId: folder.id, deleteFolder: true });
  assert.equal(profile.pages[folderPage.id], undefined);
  assert.equal(profile.pages[nestedPage.id], undefined);
  rpc['slots.paste']!({ ...base, index: 3, ...clipboard });
  const pasted = main.keys[3]!;
  const root = profile.pages[String(pasted.settings.folderId)]!;
  const child = profile.pages[String(root.keys[2]!.settings.folderId)]!;
  assert.notEqual(root.id, folderPage.id);
  assert.notEqual(child.id, nestedPage.id);
  assert.equal(root.parentId, main.id);
  assert.equal(child.parentId, root.id);
  assert.equal(root.keys[0]!.type, 'sd.back');
  assert.equal(child.keys[0]!.type, 'sd.back');
  assert.equal(root.keys[4]!.settings.pageId, child.id);
  assert.equal(child.keys[3]!.settings.pageId, root.id);
  assert.equal(root.keys[5]!.settings.pageId, main.id, 'references outside the copied subtree remain external');
  const newIds = ids(pasted, { [root.id]: root, [child.id]: child });
  assert.equal(new Set(newIds).size, newIds.length);
  assert.ok(newIds.every((id) => !oldIds.includes(id)), 'page actions and nested Multi Action steps get fresh runtime identities');
  assert.equal(engine.stateFor(root.keys[1]!.id).n, undefined, 'copied counters start with fresh runtime state');
});

test('cross-profile paste preserves ancestry and counter independence without consulting the origin', async (t) => {
  const { rpc, profile, folder, folderPage, base, engine, store, session, dev, press } = await setup(t);
  const clipboard = copyActionClipboard(folder, profile.pages);
  const before = structuredClone(clipboard);
  const oldCounterId = folderPage.keys[1]!.id;
  engine.stateFor(oldCounterId).n = 5;
  const targetId = rpc['profiles.create']!({ name: 'Clipboard target', modelId: 'neo', blank: true }) as string;
  const target = store.profile(targetId)!;
  const main = target.pages[target.pageOrder[0]!]!;
  rpc['slots.paste']!({ ...base, profileId: targetId, pageId: main.id, index: 0, ...clipboard });
  assert.deepEqual(clipboard, before, 'paste never rewrites the reusable clipboard payload');
  const pasted = main.keys[0]!;
  const copiedRoot = target.pages[String(pasted.settings.folderId)]!;
  const copiedChild = target.pages[String(copiedRoot.keys[2]!.settings.folderId)]!;
  assert.ok(!Object.keys(target.pages).some((id) => Object.hasOwn(clipboard.folderPages!, id)));
  engine.setSessionProfile(dev.id, targetId);
  session.setPage(copiedRoot.id);
  press(1);
  assert.equal(engine.stateFor(copiedRoot.keys[1]!.id).n, 1);
  assert.equal(engine.stateFor(oldCounterId).n, 5);
  session.setPage(copiedChild.id);
  assert.deepEqual(session.stack, [main.id, copiedRoot.id]);
  press(0);
  assert.equal(session.pageId, copiedRoot.id);
  assert.equal(copiedRoot.keys[4]!.settings.pageId, copiedChild.id);
});

test('malformed, missing and cyclic folder clipboard payloads leave destination content untouched', async (t) => {
  const { rpc, profile, folder, folderPage, nestedPage, base, store } = await setup(t);
  const before = structuredClone(store.config);
  const missing = copyActionClipboard(folder, profile.pages);
  delete missing.folderPages![nestedPage.id];
  assert.throws(() => rpc['slots.paste']!({ ...base, ...missing }), /folder page is missing/);
  assert.deepEqual(store.config, before);
  const cyclic = copyActionClipboard(folder, profile.pages);
  const loop = newInstance('sd.folder', uid());
  loop.settings.folderId = folderPage.id;
  cyclic.folderPages![nestedPage.id]!.keys[6] = loop;
  assert.throws(() => rpc['slots.paste']!({ ...base, ...cyclic }), /folder tree contains a cycle/);
  assert.deepEqual(store.config, before);
  const ancestryCycle = copyActionClipboard(folder, profile.pages);
  ancestryCycle.folderPages![folderPage.id]!.parentId = folderPage.id;
  assert.throws(() => rpc['slots.paste']!({ ...base, ...ancestryCycle }), /ancestry contains a cycle/);
  assert.deepEqual(store.config, before);
  assert.throws(() => rpc['slots.paste']!({ ...base, instance: folder }), /folder page is missing/);
  assert.deepEqual(store.config, before, 'a folder without a snapshot must never become an empty replacement');
  const oversized = copyActionClipboard(folder, profile.pages);
  oversized.folderPages![folderPage.id]!.keys[8] = newInstance('util.counter', uid());
  assert.throws(() => rpc['slots.paste']!({ ...base, ...oversized }), /fewer keys or dials/);
  assert.deepEqual(store.config, before, 'pasting across device sizes cannot silently discard actions');
});

test('replacing a destination folder needs an explicit flag and nonfolder instance-only paste still works', async (t) => {
  const { rpc, profile, main, folder, folderPage, nestedPage, base, store } = await setup(t);
  const clipboard = copyActionClipboard(folder, profile.pages);
  const before = structuredClone(store.config);
  assert.throws(() => rpc['slots.paste']!({ ...base, index: 3, ...clipboard }), /Confirm replacing the destination folder/);
  assert.deepEqual(store.config, before);
  rpc['slots.paste']!({ ...base, index: 3, ...clipboard, replaceFolder: true });
  assert.equal(profile.pages[folderPage.id], undefined);
  assert.equal(profile.pages[nestedPage.id], undefined);
  assert.ok(profile.pages[String(main.keys[3]!.settings.folderId)]);
  const counter = newInstance('util.counter', uid());
  const simple = copyActionClipboard(counter, profile.pages);
  assert.equal(simple.folderPages, undefined);
  rpc['slots.paste']!({ ...base, index: 0, instance: counter });
  assert.equal(main.keys[0]!.type, 'util.counter');
  assert.notEqual(main.keys[0]!.id, counter.id);
});

test('Alt-drag folder copy remaps internal page jumps and preserves outside-page references', async (t) => {
  const { rpc, profile, main, folderPage, nestedPage } = await setup(t);
  rpc['slots.move']!({ profileId: profile.id, from: { pageId: main.id, kind: 'key', index: 3 }, to: { pageId: main.id, kind: 'key', index: 0 }, copy: true });
  const copiedRoot = profile.pages[String(main.keys[0]!.settings.folderId)]!;
  const copiedChild = profile.pages[String(copiedRoot.keys[2]!.settings.folderId)]!;
  assert.notEqual(copiedRoot.id, folderPage.id);
  assert.notEqual(copiedChild.id, nestedPage.id);
  assert.equal(copiedRoot.keys[4]!.settings.pageId, copiedChild.id);
  assert.equal(copiedChild.keys[3]!.settings.pageId, copiedRoot.id);
  assert.equal(copiedRoot.keys[5]!.settings.pageId, main.id);
  assert.equal(folderPage.keys[4]!.settings.pageId, nestedPage.id, 'copying does not rewrite original targets');
});

test('page duplication shares one remap across root, nested folders and their local jumps', async (t) => {
  const { rpc, profile, main, nestedPage } = await setup(t);
  main.keys[6] = newInstance('sd.page.goto', uid());
  main.keys[6]!.settings.pageId = nestedPage.id;
  main.keys[7] = newInstance('sd.page.goto', uid());
  main.keys[7]!.settings.pageId = main.id;
  nestedPage.keys[6] = newInstance('sd.page.goto', uid());
  nestedPage.keys[6]!.settings.pageId = profile.pageOrder[1]!;
  const copyId = rpc['pages.duplicate']!({ profileId: profile.id, pageId: main.id }) as string;
  const copy = profile.pages[copyId]!;
  const copiedRoot = profile.pages[String(copy.keys[3]!.settings.folderId)]!;
  const copiedChild = profile.pages[String(copiedRoot.keys[2]!.settings.folderId)]!;
  assert.equal(copy.keys[6]!.settings.pageId, copiedChild.id);
  assert.equal(copy.keys[7]!.settings.pageId, copy.id);
  assert.equal(copiedRoot.keys[4]!.settings.pageId, copiedChild.id);
  assert.equal(copiedRoot.keys[5]!.settings.pageId, copy.id, 'the old root is local to a whole-page copy');
  assert.equal(copiedChild.keys[3]!.settings.pageId, copiedRoot.id);
  assert.equal(copiedChild.keys[6]!.settings.pageId, profile.pageOrder.find((id) => id !== main.id && id !== copy.id), 'a root page outside the copied tree remains external');
  assert.equal(copiedRoot.parentId, copy.id);
  assert.equal(copiedChild.parentId, copiedRoot.id);
  assert.notEqual(copy.keys[6]!.id, main.keys[6]!.id);
});

test('edits that would orphan folders or expand the slot layout fail before saving', async t => {
  const { rpc, profile, main, folderPage, base, store } = await setup(t);
  const move = (from: number, to: number, copy: boolean) => rpc['slots.move']!({
    profileId: profile.id,
    from: { pageId: main.id, kind: 'key', index: from },
    to: { pageId: main.id, kind: 'key', index: to },
    copy,
  });
  const before = structuredClone(store.config);
  assert.throws(() => move(6, 3, true), /replacing this folder/);
  assert.throws(() => move(6, main.keys.length, false), /Slot out of range/);
  assert.throws(() => rpc['pages.delete']!({ profileId: profile.id, pageId: folderPage.id }), /owning folder key/);
  assert.deepEqual(store.config, before);

  const reference = newInstance('sd.folder', uid());
  reference.settings.folderId = folderPage.id;
  await rpc['slots.assign']!({ ...base, index: 6, configured: true, type: 'sd.multi', settings: { steps: [reference] } });
  const withReference = structuredClone(store.config);
  assert.throws(() => rpc['slots.clear']!({ ...base, index: 3, deleteFolder: true }), /Remove or retarget that step/);
  assert.deepEqual(store.config, withReference);
  store.flush();
  assert.deepEqual(new Store(store.dir).config, withReference);
});

test('a copied Multi Action with an independent folder reference reloads and keeps the copied page after clearing the action', async t => {
  const { rpc, profile, main, folderPage, base, store } = await setup(t);
  const reference = newInstance('sd.folder', uid());
  reference.settings.folderId = folderPage.id;
  await rpc['slots.assign']!({ ...base, index: 6, configured: true, type: 'sd.multi', settings: { steps: [reference] } });
  const clipboard = copyActionClipboard(main.keys[6]!, profile.pages);
  await rpc['slots.paste']!({ ...base, index: 7, ...clipboard });
  const copy = (main.keys[7]!.settings.steps as ActionInstance[])[0]!;
  const copyPageId = String(copy.settings.folderId);
  assert.notEqual(copyPageId, folderPage.id);
  assert.equal(profile.pages[copyPageId]!.parentId, null);
  assert.ok(profile.pageOrder.includes(copyPageId));
  assert.equal(profile.pages[copyPageId]!.keys[2]!.type, 'sd.folder');
  store.flush();
  assert.deepEqual(new Store(store.dir).config, store.config);
  await rpc['slots.clear']!({ ...base, index: 7 });
  assert.ok(profile.pages[copyPageId]);
});

test('swapping owning folder keys updates both parent links and rejects moves into descendants', async t => {
  const { rpc, profile, main, folderPage, store } = await setup(t);
  const second = profile.pages[profile.pageOrder[1]!]!;
  const key = (pageId: string, index: number) => ({ pageId, index, kind: 'key' });
  await rpc['slots.assign']!({ profileId: profile.id, ...key(second.id, 6), type: 'sd.folder' });
  const otherFolderId = String(second.keys[6]!.settings.folderId);
  await rpc['slots.move']!({ profileId: profile.id, from: key(main.id, 3), to: key(second.id, 6) });
  assert.equal(profile.pages[folderPage.id]!.parentId, second.id);
  assert.equal(profile.pages[otherFolderId]!.parentId, main.id);
  const before = structuredClone(store.config);
  assert.throws(() => rpc['slots.move']!({ profileId: profile.id, from: key(second.id, 6), to: key(folderPage.id, 7) }), /cyclic/);
  assert.deepEqual(store.config, before);
  store.flush();
  assert.deepEqual(new Store(store.dir).config, store.config);
});

test('a failed profile save does not publish a staged slot edit', async t => {
  const { rpc, base, store, engine } = await setup(t);
  store.flush();
  const original = structuredClone(store.config);
  const flush = store.flush.bind(store);
  let stateEvents = 0;
  engine.on('state', () => stateEvents++);
  store.flush = () => { throw new Error('fixture disk write failed'); };
  try {
    assert.throws(() => rpc['slots.assign']!({ ...base, type: 'util.counter' }), /fixture disk write failed/);
    assert.deepEqual(store.config, original);
    assert.deepEqual(new Store(store.dir).config, original);
    assert.equal(stateEvents, 0);
  } finally { store.flush = flush; }
});
