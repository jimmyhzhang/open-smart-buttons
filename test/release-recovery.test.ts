import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store, uid } from '../src/engine/store.ts';
import { newInstance } from '../src/engine/actions.ts';

test('recovery writes a validated copy without changing the original config bytes', t => {
  const root = mkdtempSync(join(tmpdir(), 'osb-recover-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = new Store(join(root, 'source'), true);
  const profile = source.config.profiles[0]!;
  const main = profile.pages[profile.pageOrder[0]!]!;
  const orphan = String(main.keys[3]!.settings.folderId);
  main.keys[3] = null;

  const missing = newInstance('sd.folder', uid());
  missing.settings.folderId = 'missing';
  missing.appearance.title = 'Keep this action';
  const workflow = newInstance('sd.multi', uid());
  workflow.settings.steps = [missing];
  main.keys[6] = workflow;

  const overflow = newInstance('util.counter', uid());
  main.keys.push(overflow);
  source.flush();
  const original = readFileSync(join(source.dir, 'config.json'));
  assert.throws(() => new Store(source.dir), /preserved/);
  const output = join(root, 'recovered');
  execFileSync(process.execPath, ['src/tools/recover-data.ts', source.dir, output]);
  const repaired = new Store(output).config.profiles[0]!;
  assert.deepEqual(readFileSync(join(source.dir, 'config.json')), original);
  assert.deepEqual(readFileSync(join(output, 'config.original.json')), original);
  assert.ok(repaired.pageOrder.includes(orphan));
  assert.equal(repaired.pages[orphan]!.parentId, null);
  const step = (repaired.pages[main.id]!.keys[6]!.settings.steps as typeof missing[])[0]!;
  assert.equal(step.type, 'unsupported');
  assert.deepEqual(step.settings.originalAction, missing);
  assert.ok(Object.values(repaired.pages).some(page => page.keys.some(key => key?.id === overflow.id)));
  assert.throws(() => execFileSync(process.execPath, ['src/tools/recover-data.ts', source.dir, output], { stdio: 'pipe' }));
  assert.deepEqual(readFileSync(join(output, 'config.original.json')), original);
});

test('ambiguous ownership leaves source bytes and output directory untouched', t => {
  const root = mkdtempSync(join(tmpdir(), 'osb-recover-ambiguous-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new Store(join(root, 'source'), true);
  const profile = store.config.profiles[0]!;
  const main = profile.pages[profile.pageOrder[0]!]!;
  const duplicate = newInstance('sd.folder', uid());
  duplicate.settings.folderId = main.keys[3]!.settings.folderId;
  main.keys[6] = duplicate;
  store.flush();
  const file = join(store.dir, 'config.json');
  const original = readFileSync(file);
  const output = join(root, 'recovered');
  assert.throws(() => execFileSync(process.execPath, ['src/tools/recover-data.ts', store.dir, output], { stdio: 'pipe' }), /multiple owning keys/);
  assert.equal(existsSync(output), false);
  assert.deepEqual(readFileSync(file), original);
});
