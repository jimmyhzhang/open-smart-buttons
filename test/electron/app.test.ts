// Electron end-to-end suite (plan section 7, milestone M2). Each test launches the dev app (`electron .`)
// with --sim on its own temporary profile and never touches ~/.open-smart-buttons, port 4417 or USB.
//   node --test --test-concurrency=1 test/electron/*.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  findPage, kill, launchApp, lockExists, makeProfile, openEditor, readLog, readServer, sleep, startCli,
  visibleWindowCount, waitFor, waitForEditor, waitForService, type Profile,
} from './helpers.ts';
import type { ElectronApplication } from 'playwright-core';
import { Store } from '../../src/engine/store.ts';
import type { Config } from '../../src/shared/types.ts';

const ONBOARDED = { onboarded: true, showInMenuBar: true };
const TEST_TIMEOUT = 90_000;

async function withProfile(opts: Parameters<typeof makeProfile>[0], fn: (profile: Profile) => Promise<void>) {
  const profile = await makeProfile(opts);
  try { await fn(profile); }
  catch (error) {
    // Attach the tail of the app log: it says what the main process and service saw.
    (error as Error).message += `\n--- app log ---\n${readLog(profile).slice(-3000)}`;
    throw error;
  } finally { await profile.cleanup(); }
}

/** Replaces the native confirmation sheet: the first button (the action, e.g. Repair) is chosen. */
async function stubConfirm(app: ElectronApplication) {
  await app.evaluate(({ dialog }) => {
    (dialog as unknown as { showMessageBox: () => Promise<{ response: number; checkboxChecked: boolean }> }).showMessageBox = async () => ({ response: 0, checkboxChecked: false });
  });
}

/** Kills the service with SIGKILL and waits for the supervisor to bring up a new one. */
async function crashAndWaitForRestart(profile: Profile, ms: number) {
  const before = readServer(profile.dataDir);
  assert.ok(before, 'server.json is missing');
  kill(before.pid, 'SIGKILL');
  const after = await waitForService(profile, ms, before.pid);
  return { before, after };
}

test('boots to a connected editor with no launch link', { timeout: TEST_TIMEOUT }, () => withProfile({ prefs: ONBOARDED }, async (profile) => {
  const app = await launchApp(profile);
  const server = await waitForService(profile);
  const page = await openEditor(app);
  await waitForEditor(page);
  assert.equal(new URL(page.url()).origin, `http://127.0.0.1:${server.port}`);
  assert.equal(new URL(page.url()).pathname, '/');
  assert.equal(await page.getByText('Open the editor using the link').count(), 0);
}));

test('a killed service comes back on the same origin and the editor keeps its state', { timeout: TEST_TIMEOUT }, () => withProfile({ prefs: ONBOARDED }, async (profile) => {
  const app = await launchApp(profile);
  await waitForService(profile);
  const page = await openEditor(app);
  await waitForEditor(page);
  const origin = new URL(page.url()).origin;
  // Choose Dark the way Settings does: the app's choice, mirrored into this window.
  await page.evaluate(() => (window as unknown as { osbNative: { setPref(k: string, v: unknown): Promise<unknown> } }).osbNative.setPref('theme', 'dark'));
  await waitFor(() => page.evaluate(() => document.documentElement.dataset.theme === 'dark'), 3000, 'the editor did not follow the app theme');

  const started = Date.now();
  const { before, after } = await crashAndWaitForRestart(profile, 3000);
  assert.equal(after.port, before.port, 'the service moved to another port');
  // The editor's own reconnect loop (1 s) brings it back without a page reload.
  await page.locator('.offline').waitFor({ state: 'detached', timeout: Math.max(500, 3000 - (Date.now() - started)) + 1500 });
  await page.locator('#deck-key-0').waitFor({ state: 'visible', timeout: 3000 });
  assert.ok(Date.now() - started < 4500, `reconnect took ${Date.now() - started} ms`);
  assert.equal(new URL(page.url()).origin, origin);
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
  assert.equal(await page.evaluate(() => localStorage.getItem('osb.theme')), 'dark');
  assert.equal(await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource), 'dark');
}));

test('three crashes within a minute show Restart, which brings the editor back', { timeout: TEST_TIMEOUT }, () => withProfile({ prefs: ONBOARDED }, async (profile) => {
  const app = await launchApp(profile);
  await waitForService(profile);
  const page = await openEditor(app);
  await waitForEditor(page);

  await crashAndWaitForRestart(profile, 10_000);
  await crashAndWaitForRestart(profile, 10_000);
  const last = readServer(profile.dataDir);
  assert.ok(last);
  kill(last.pid, 'SIGKILL');

  const status = await findPage(app, 'editor', 10_000).then(async (p) => {
    await waitFor(() => p.url().startsWith('osb://status/') && p.url().includes('status.html'), 10_000, `The status page did not appear (at ${p.url()}).`);
    return p;
  });
  const restart = status.getByRole('button', { name: 'Restart' });
  await restart.waitFor({ state: 'visible', timeout: 10_000 });
  assert.equal(await status.getByText('stopped unexpectedly').count(), 1);
  await restart.click();
  await waitForEditor(status, 20_000);
}));

test('quitting releases the data directory lock', { timeout: TEST_TIMEOUT }, () => withProfile({ prefs: ONBOARDED }, async (profile) => {
  const app = await launchApp(profile);
  const server = await waitForService(profile);
  assert.ok(lockExists(profile));
  const proc = app.process();
  const exited = new Promise<void>((resolve) => proc.once('exit', () => resolve()));
  // Quit on the next tick so the evaluate call returns before the main process goes away.
  await app.evaluate(({ app: a }) => { setTimeout(() => a.quit(), 0); });
  await waitFor(() => !lockExists(profile), 3000, 'server.lock is still there 3 s after quitting');
  await Promise.race([exited, sleep(5000)]);
  assert.ok(proc.exitCode !== null || proc.signalCode !== null, 'the app did not exit');
  await waitFor(() => { try { process.kill(server.pid, 0); return false; } catch { return true; } }, 3000, 'the service outlived the app');
}));

test('after onboarding, a launch lives in the menu bar and opens no window', { timeout: TEST_TIMEOUT }, () => withProfile({ prefs: ONBOARDED }, async (profile) => {
  const app = await launchApp(profile);
  await waitForService(profile);
  await waitFor(() => readLog(profile).includes('service ready on port'), 10_000, 'the service never reported ready');
  await sleep(1000);
  assert.equal(await visibleWindowCount(app), 0);
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 0);
}));

test('a first launch opens onboarding', { timeout: TEST_TIMEOUT }, () => withProfile({}, async (profile) => {
  const app = await launchApp(profile);
  const page = await findPage(app, 'onboarding');
  await waitFor(() => page.url().startsWith('http://127.0.0.1:') && page.url().includes('view=onboarding'), 20_000, `onboarding did not load from the service (at ${page.url()})`);
  await waitFor(() => visibleWindowCount(app).then((n) => n === 1), 10_000, 'the onboarding window is not visible');
  assert.equal(app.windows().filter((p) => !p.isClosed()).length, 1, 'only the onboarding window should open');
}));

test('the editor window is locked to the app', { timeout: TEST_TIMEOUT }, () => withProfile({ prefs: ONBOARDED }, async (profile) => {
  const app = await launchApp(profile);
  await waitForService(profile);
  const page = await openEditor(app);
  await waitForEditor(page);
  const origin = new URL(page.url()).origin;

  // New windows are denied.
  const opened = await page.evaluate(() => window.open('https://example.com') === null);
  assert.equal(opened, true, 'window.open returned a window');
  await sleep(500);
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
  assert.equal(app.windows().filter((p) => !p.isClosed()).length, 1);

  // Navigation away is blocked.
  await page.evaluate(() => { location.href = 'https://example.com/'; });
  await sleep(1000);
  assert.equal(new URL(page.url()).origin, origin);
  assert.equal(await page.evaluate(() => location.origin), origin);

  // A download the editor did not create as a blob is cancelled.
  await app.evaluate(({ session }) => {
    const g = globalThis as unknown as { osbDownloads: { url: string; prevented: boolean; state?: string }[] };
    g.osbDownloads = [];
    session.defaultSession.on('will-download', (event, item) => {
      const record: { url: string; prevented: boolean; state?: string } = { url: item.getURL(), prevented: event.defaultPrevented };
      g.osbDownloads.push(record);
      // A prevented download's item is destroyed right away: getState() then throws.
      setTimeout(() => { try { record.state = item.getState(); } catch { record.state = 'destroyed'; } }, 200);
    });
  });
  await page.evaluate(() => {
    const a = document.createElement('a');
    a.href = 'data:text/plain,not-from-the-editor';
    a.download = 'osb-e2e-blocked.txt';
    document.body.append(a);
    a.click();
    a.remove();
  });
  const downloads = await waitFor(async () => {
    const list = await app.evaluate(() => (globalThis as unknown as { osbDownloads: { url: string; prevented: boolean; state?: string }[] }).osbDownloads);
    return list.length && list[0]!.state ? list : null;
  }, 5000, 'the download never started');
  assert.equal(downloads.length, 1);
  assert.equal(downloads[0]!.prevented, true, `download was not cancelled: ${JSON.stringify(downloads[0])}`);
  assert.ok(['destroyed', 'cancelled', 'interrupted'].includes(downloads[0]!.state!), `download kept going: ${JSON.stringify(downloads[0])}`);

  // The bridge is a fixed, frozen set of calls, and main refuses unknown commands.
  const bridge = await page.evaluate(() => {
    const n = (window as unknown as { osbNative: Record<string, unknown> }).osbNative;
    return { keys: Object.keys(n).sort(), frozen: Object.isFrozen(n), types: Object.values(n).map((v) => typeof v) };
  });
  assert.deepEqual(bridge.keys, ['command', 'contextMenu', 'getState', 'onMenu', 'onState', 'setApiKey', 'setPref']);
  assert.equal(bridge.frozen, true, 'window.osbNative is not frozen');
  assert.ok(bridge.types.every((t) => t === 'function'));
  const rejected = await page.evaluate(async () => {
    try { await (window as unknown as { osbNative: { command(n: string): Promise<unknown> } }).osbNative.command('nope'); return 'resolved'; }
    catch (error) { return String((error as Error).message); }
  });
  assert.match(rejected, /Unknown command/);
}));

test('a terminal service holding the data shows how to continue, then Try Again connects', { timeout: TEST_TIMEOUT }, () => withProfile({ prefs: ONBOARDED }, async (profile) => {
  const cli = await startCli(profile);
  const app = await launchApp(profile);
  const page = await openEditor(app);
  await page.getByText('Your data folder is already in use.', { exact: true }).waitFor({ state: 'visible', timeout: 20_000 });
  assert.ok(page.url().startsWith('osb://status/'), `expected the status page, at ${page.url()}`);
  await cli.stop();
  await waitFor(() => !lockExists(profile), 5000, 'the terminal service left its lock behind');
  await page.getByRole('button', { name: 'Try Again' }).click();
  await waitForEditor(page, 20_000);
}));

test('unreadable settings offer Repair, which keeps the original and loads the editor', { timeout: TEST_TIMEOUT }, () => withProfile({
  prefs: ONBOARDED,
  setup: (dataDir) => {
    // A known editor defect: a page with one key slot too many. The loader refuses it; recovery fixes it.
    new Store(dataDir, true).flush();
    const config = JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8')) as Config;
    const profile = config.profiles[0]!;
    profile.pages[profile.pageOrder[0]!]!.keys.push(null);
    writeFileSync(join(dataDir, 'config.json'), JSON.stringify(config));
  },
}, async (profile) => {
  const originalBytes = readFileSync(join(profile.dataDir, 'config.json'), 'utf8');
  const app = await launchApp(profile);
  const page = await openEditor(app);
  await page.getByText("couldn't be read").waitFor({ state: 'visible', timeout: 20_000 });
  assert.ok(page.url().startsWith('osb://status/'), `expected the status page, at ${page.url()}`);
  await stubConfirm(app);
  await page.getByRole('button', { name: 'Repair' }).click();
  await waitForEditor(page, 20_000);
  const original = readdirSync(profile.dir).find((name) => name.startsWith('data-original-'));
  assert.ok(original, `no data-original-* folder in ${readdirSync(profile.dir).join(', ')}`);
  assert.equal(readFileSync(join(profile.dir, original, 'config.json'), 'utf8'), originalBytes);
}));

test('settings that are not JSON at all show the recovery screen', { timeout: TEST_TIMEOUT }, () => withProfile({
  prefs: ONBOARDED,
  setup: (dataDir) => { writeFileSync(join(dataDir, 'config.json'), '{ not json'); },
}, async (profile) => {
  const app = await launchApp(profile);
  const page = await openEditor(app);
  await page.getByText("couldn't be read").waitFor({ state: 'visible', timeout: 20_000 });
  assert.ok(page.url().startsWith('osb://status/'), `expected the status page, at ${page.url()}`);
  for (const name of ['Repair', 'Show in Finder', 'Start Fresh']) {
    assert.equal(await page.getByRole('button', { name }).count(), 1, `missing ${name}`);
  }
}));

test('settings that are not JSON: Repair explains, Start Fresh keeps the old folder and loads the editor', { timeout: TEST_TIMEOUT }, () => withProfile({
  prefs: ONBOARDED,
  setup: (dataDir) => { writeFileSync(join(dataDir, 'config.json'), '{ not json'); },
}, async (profile) => {
  const app = await launchApp(profile);
  const page = await openEditor(app);
  await page.getByText("couldn't be read").waitFor({ state: 'visible', timeout: 20_000 });
  await stubConfirm(app);
  await page.getByRole('button', { name: 'Repair' }).click();
  await page.getByText('damaged beyond repair').waitFor({ state: 'visible', timeout: 10_000 });
  assert.equal(await page.getByText('Expected property name').count(), 0, 'raw parser text leaked into the UI');
  await page.getByRole('button', { name: 'Start Fresh' }).click();
  await waitForEditor(page, 20_000);
  const aside = readdirSync(profile.dir).find((name) => name.startsWith('data-unreadable-'));
  assert.ok(aside, `no data-unreadable-* folder in ${readdirSync(profile.dir).join(', ')}`);
  assert.equal(readFileSync(join(profile.dir, aside, 'config.json'), 'utf8'), '{ not json');
}));

test('app menu commands reach the editor', { timeout: TEST_TIMEOUT }, () => withProfile({ prefs: ONBOARDED }, async (profile) => {
  const app = await launchApp(profile);
  await waitForService(profile);
  const page = await openEditor(app);
  await waitForEditor(page);
  const click = (label: string) => app.evaluate(({ Menu }, label) => {
    const find = (items: Electron.MenuItem[]): Electron.MenuItem | undefined => {
      for (const item of items) {
        if (item.label === label) return item;
        const inner = item.submenu ? find(item.submenu.items) : undefined;
        if (inner) return inner;
      }
      return undefined;
    };
    const item = find(Menu.getApplicationMenu()!.items);
    if (!item) throw new Error(`no menu item ${label}`);
    item.click();
  }, label);
  await click('Use Mode');
  const checked = (name: RegExp) => page.getByRole('radio', { name }).getAttribute('aria-checked');
  await waitFor(async () => (await checked(/^Use/)) === 'true', 5000, 'Use mode was not selected');
  await click('Edit Mode');
  await waitFor(async () => (await checked(/^Edit/)) === 'true', 5000, 'Edit mode was not selected');
  await click('New Profile');
  await waitFor(async () => (await page.evaluate(() => (document.activeElement as HTMLInputElement | null)?.value ?? '')) === 'Untitled Profile',
    5000, 'New Profile did not open the inline rename');
}));

test('with the menu bar extra off, launch opens the editor so the app stays reachable', { timeout: TEST_TIMEOUT }, () => withProfile({ prefs: { onboarded: true, showInMenuBar: false } }, async (profile) => {
  const app = await launchApp(profile);
  await waitForService(profile);
  await waitFor(async () => (await visibleWindowCount(app)) === 1, 15_000, 'no window opened');
  const dock = await app.evaluate(({ app }) => app.dock?.isVisible() ?? true);
  assert.equal(dock, true, 'the Dock icon must stay when the menu bar extra is off');
}));
