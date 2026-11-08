import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { findPage, launchApp, makeProfile, waitFor, waitForEditor } from './helpers.ts';

test('native identity, About, profile export and saved preferences use the new name', { timeout: 45_000 }, async () => {
  const profile = await makeProfile({ prefs: { onboarded: true, showInMenuBar: false, theme: 'dark', aiProvider: 'codex' } });
  try {
    const app = await launchApp(profile);
    const page = await findPage(app, 'editor');
    await waitForEditor(page);
    assert.equal(await page.title(), 'Open Smart Buttons');
    const identity = await app.evaluate(({ app, Menu, BrowserWindow }) => ({
      name: app.getName(), menu: Menu.getApplicationMenu()?.items[0]?.label,
      titles: BrowserWindow.getAllWindows().map(window => window.getTitle()),
    }));
    assert.equal(identity.name, 'Open Smart Buttons');
    assert.equal(identity.menu, 'Open Smart Buttons');
    assert.equal(identity.titles.some(title => /StreamDeckPlus/.test(title)), false);
    await app.evaluate(({ session, Menu }) => {
      session.defaultSession.once('will-download', (event, item) => {
        (globalThis as unknown as { exportName: string }).exportName = item.getFilename();
        event.preventDefault();
      });
      const item = Menu.getApplicationMenu()?.items.find(item => item.label === 'File')?.submenu?.items.find(item => item.label === 'Export Profile…');
      item?.click();
    });
    const name = await waitFor(() => app.evaluate(() => (globalThis as unknown as { exportName?: string }).exportName), 5000, 'profile export');
    assert.match(name, /\.osb\.json$/);
    await page.evaluate(() => (window as any).osbNative.command('settings.open', 'about'));
    const settings = await findPage(app, 'settings');
    await settings.getByRole('heading', { name: 'Open Smart Buttons', exact: true }).waitFor();
    await settings.getByText('Not affiliated with or endorsed by Elgato or Corsair.', { exact: false }).waitFor();
    const state = await settings.evaluate(() => (window as any).osbNative.getState());
    assert.equal(state.prefs.theme, 'dark');
    assert.equal(state.prefs.aiProvider, 'codex');
  } finally { await profile.cleanup(); }
});

test('an unreadable saved key is retained and offers recovery without claiming a working credential', { timeout: 45_000 }, async () => {
  const profile = await makeProfile({ prefs: { onboarded: true, showInMenuBar: false, aiProvider: 'api' } });
  const file = join(profile.dir, 'anthropic-key.bin');
  const encrypted = Buffer.from('unreadable-ciphertext-fixture');
  writeFileSync(file, encrypted, { mode: 0o600 });
  try {
    const app = await launchApp(profile);
    const page = await findPage(app, 'editor');
    await waitForEditor(page);
    await waitFor(async () => {
      const state = await page.evaluate(() => (window as any).osbNative.getState());
      return state.ai.keyNeedsReentry && !state.ai.hasKey;
    }, 5000, 'unreadable key recovery state');
    assert.deepEqual(readFileSync(file), encrypted, 'failed decryption must not erase the stored file');
    await page.evaluate(() => (window as any).osbNative.command('settings.open', 'ai'));
    const settings = await findPage(app, 'settings');
    await settings.getByText(/Your saved API key could not be unlocked/).waitFor();
    await settings.getByRole('textbox', { name: 'API key', exact: true }).fill('osb-fixture-not-a-real-api-key');
    await settings.getByRole('button', { name: 'Save Key', exact: true }).click();
    await waitFor(async () => {
      const state = await settings.evaluate(() => (window as any).osbNative.getState());
      return state.ai.hasKey && !state.ai.keyNeedsReentry;
    }, 5000, 'replacement key stored');
    assert.equal(readFileSync(file).includes(Buffer.from('osb-fixture-not-a-real-api-key')), false, 'saved credential stays encrypted');
  } finally { await profile.cleanup(); }
});

test('the recovery protocol cannot expose other app files or accept writes', { timeout: 45_000 }, async () => {
  const profile = await makeProfile({
    prefs: { onboarded: true, showInMenuBar: false },
    setup: data => writeFileSync(join(data, 'config.json'), '{invalid-json'),
  });
  try {
    const app = await launchApp(profile);
    const page = await findPage(app, 'editor');
    await page.getByRole('heading', { name: "Your settings couldn't be read.", exact: true }).waitFor();
    const result = await app.evaluate(async ({ net }) => {
      const statuses = await Promise.all([
        'osb://status/status.css', 'osb://status/status.js',
        'osb://status/../main.ts', 'osb://status/%2e%2e/secrets.ts', 'osb://other/status.html',
      ].map(async url => (await net.fetch(url)).status));
      const post = await net.fetch('osb://status/status.html', { method: 'POST' });
      const head = await net.fetch('osb://status/status.html', { method: 'HEAD' });
      return { statuses, post: post.status, head: head.status, headBody: await head.text() };
    });
    assert.deepEqual(result, { statuses: [200, 200, 404, 404, 404], post: 405, head: 200, headBody: '' });
  } finally { await profile.cleanup(); }
});
