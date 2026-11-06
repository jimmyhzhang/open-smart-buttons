import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appIconPng, chooseOnMac, listInstalledApps, listShortcutNames, resolveApp, tildePath } from '../src/engine/host.ts';
import type { CommandRunner } from '../src/engine/platform.ts';

test('tildePath shortens home paths only', () => {
  assert.equal(tildePath('/Users/a/repos/x/', '/Users/a'), '~/repos/x');
  assert.equal(tildePath('/Users/a', '/Users/a'), '~');
  assert.equal(tildePath('/Users/ab/x', '/Users/a'), '/Users/ab/x');
  assert.equal(tildePath('/', '/Users/a'), '/');
});

test('shortcut suggestions use the bounded list command and allow manual entry on failure', async () => {
  const run: CommandRunner = async (cmd, args, timeout) => {
    assert.equal(cmd, '/usr/bin/shortcuts');
    assert.deepEqual(args, ['list']);
    assert.equal(timeout, 3000);
    return { code: 0, stdout: 'Focus time\r\nOpen work\nFocus time\n\n-invalid\n', stderr: '' };
  };
  assert.deepEqual(await listShortcutNames(run), ['Focus time', 'Open work']);
  await assert.rejects(listShortcutNames(async () => ({ code: 1, stdout: '', stderr: '' })), /manually/);
});

test('native chooser builds a safe AppleScript and maps cancel to null', async () => {
  const seen: string[][] = [];
  const ok: CommandRunner = async (cmd, args) => { seen.push([cmd, ...args]); return { code: 0, stdout: '/Applications/Safari.app/\n', stderr: '' }; };
  assert.equal(await chooseOnMac('app', 'Pick "it"\n now', ok), '/Applications/Safari.app');
  assert.equal(seen[0]![0], 'osascript');
  assert.ok(seen[0]!.includes('activate'));
  assert.match(seen[0]!.at(-1)!, /choose application with prompt "Pick \\"it\\" now" as alias/);
  const cancel: CommandRunner = async () => ({ code: 1, stdout: '', stderr: 'execution error: User canceled. (-128)' });
  assert.equal(await chooseOnMac('folder', 'x', cancel), null);
  const broken: CommandRunner = async () => ({ code: 1, stdout: '', stderr: 'boom' });
  await assert.rejects(chooseOnMac('file', 'x', broken), /boom/);
});

test('installed apps are listed, de-duplicated, and resolvable by name', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'sdp-apps-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const a = join(root, 'A'), b = join(root, 'B');
  for (const d of [a, b]) mkdirSync(d);
  for (const n of ['Safari.app', 'zoom.us.app', 'notes.txt', '.Hidden.app']) mkdirSync(join(a, n));
  mkdirSync(join(b, 'Safari.app'));
  mkdirSync(join(b, 'Calculator.app'));
  const apps = listInstalledApps([a, b, join(root, 'missing')]);
  assert.deepEqual(apps.map((x) => x.name), ['Calculator', 'Safari', 'zoom.us']);
  assert.equal(apps.find((x) => x.name === 'Safari')!.path, join(a, 'Safari.app'));
  assert.equal(resolveApp('safari', apps), join(a, 'Safari.app'));
  assert.equal(resolveApp('Zoom.us.app', apps), join(a, 'zoom.us.app'));
  assert.equal(resolveApp('Nope', apps), null);
  assert.equal(resolveApp('', apps), null);
});

test('app icons are converted from the bundle icns with sips', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'sdp-icon-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const app = join(root, 'Demo.app');
  mkdirSync(join(app, 'Contents', 'Resources'), { recursive: true });
  writeFileSync(join(app, 'Contents', 'Info.plist'), '');
  writeFileSync(join(app, 'Contents', 'Resources', 'AppIcon.icns'), 'icns');
  const calls: string[][] = [];
  const run: CommandRunner = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd.endsWith('plutil')) return { code: 0, stdout: 'AppIcon', stderr: '' };
    writeFileSync(args.at(-1)!, 'PNGDATA');
    return { code: 0, stdout: '', stderr: '' };
  };
  const png = await appIconPng(app, run);
  assert.equal(Buffer.from(png!).toString(), 'PNGDATA');
  assert.ok(calls[1]!.includes(join(app, 'Contents', 'Resources', 'AppIcon.icns')));
  assert.equal(await appIconPng(join(root, 'Missing.app'), run), null);
});
