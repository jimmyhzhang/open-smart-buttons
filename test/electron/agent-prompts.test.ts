import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Config } from '../../src/shared/types.ts';
import { findPage, launchApp, makeProfile, waitForEditor, waitFor } from './helpers.ts';

test('a delayed native picker check preserves the project input, its focus and draft', { timeout: 30_000 }, async () => {
  const profile = await makeProfile({ prefs: { onboarded: true, showInMenuBar: false, aiProvider: 'api' } });
  try {
    const app = await launchApp(profile);
    const page = await findPage(app, 'editor');
    await waitForEditor(page);
    let releasePicker: (() => void) | undefined;
    await page.routeWebSocket('**/ws', route => {
      const server = route.connectToServer();
      let pickerId: number | undefined;
      route.onMessage(raw => {
        const message = JSON.parse(String(raw));
        if (message.method === 'host.info') pickerId = message.id;
        server.send(raw);
      });
      server.onMessage(raw => {
        const message = JSON.parse(String(raw));
        if (pickerId !== undefined && message.id === pickerId) releasePicker = () => route.send(raw);
        else route.send(raw);
      });
    });
    await page.reload();
    await waitForEditor(page);
    await page.locator('#deck-key-0').click();
    await page.getByRole('button', { name: 'Set up manually', exact: true }).click();
    const library = page.getByRole('complementary', { name: 'Action library' });
    await library.getByRole('textbox', { name: 'Search actions' }).fill('Run prompt with Codex');
    await library.getByText('Run prompt with Codex', { exact: true }).click();
    const dialog = page.getByRole('dialog');
    const cwd = dialog.locator('input[data-field-key="cwd"]');
    await cwd.fill(profile.dir);
    const input = await cwd.elementHandle();
    await waitFor(() => releasePicker, 3000, 'picker capability response captured');
    releasePicker!();
    await dialog.getByRole('button', { name: 'Browse for project folder', exact: true }).waitFor();
    assert.equal(await input!.evaluate(el => el.isConnected && el === document.activeElement), true, 'native capability discovery must not replace or blur a field being edited');
    assert.equal(await cwd.inputValue(), profile.dir);
  } finally { await profile.cleanup(); }
});

test('prompt presets expose skills, validate before save, retain edits and never execute in the simulator', { timeout: 60_000 }, async () => {
  const profile = await makeProfile({ prefs: { onboarded: true, showInMenuBar: false, aiProvider: 'api' } });
  try {
    const app = await launchApp(profile);
    const page = await findPage(app, 'editor');
    await waitForEditor(page);
    page.setDefaultTimeout(7500);
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows().find(w => new URL(w.webContents.getURL()).search === '')?.setContentSize(960, 620);
    });
    await page.locator('#deck-key-0').click();
    const panel = page.getByRole('complementary', { name: 'Key workspace' });
    for (const tool of ['Claude', 'Codex']) {
      await panel.getByRole('button', { name: 'Set up manually', exact: true }).click();
      const library = page.getByRole('complementary', { name: 'Action library' });
      const name = `Run prompt with ${tool}`;
      await library.getByRole('textbox', { name: 'Search actions' }).fill(name);
      await library.getByText(name, { exact: true }).click();
      const dialog = page.getByRole('dialog');
      const prompt = dialog.getByRole('textbox', { name: /^Prompt/ });
      await prompt.waitFor({ state: 'visible' });
      assert.equal(await dialog.getByRole('combobox', { name: 'Run in', exact: true }).inputValue(), 'background');
      assert.equal(await dialog.getByText('Session options', { exact: true }).count(), 0);
      if (tool === 'Codex') assert.equal(await dialog.locator('input[data-field-key="cwd"]').inputValue(), profile.dir, 'changing executor reuses the project');
      await dialog.locator('.setup-actions .primary').click();
      assert.equal(await prompt.getAttribute('aria-invalid'), 'true');
      await waitFor(() => prompt.evaluate(el => el === document.activeElement), 2000, 'invalid prompt receives focus');
      const savedPrompt = `${tool === 'Claude' ? '/' : '$'}review\nReview the project and explain your findings.`;
      await prompt.fill(savedPrompt);
      await dialog.locator('input[data-field-key="cwd"]').fill(profile.dir);
      await dialog.getByRole('textbox', { name: 'Button label', exact: true }).fill(`${tool} review`);
      assert.equal(await dialog.locator('input[data-field-key="cwd"]').inputValue(), profile.dir, 'editing the label preserves the project');
      await dialog.getByRole('combobox', { name: 'Target button' }).selectOption('key:0');
      await dialog.locator('.setup-actions .primary').click();
      await dialog.waitFor({ state: 'detached' });
      assert.equal(await panel.getByLabel('Prompt execution', { exact: true }).count(), 0, 'saving starts no task');
      await panel.getByRole('button', { name: 'Configure', exact: true }).click();
      await prompt.waitFor({ state: 'visible' });
      assert.equal(await prompt.inputValue(), savedPrompt);
      await prompt.fill(`${savedPrompt}\nKeep files unchanged.`);
      await dialog.getByRole('button', { name: /^Save changes/ }).click();
      await dialog.waitFor({ state: 'detached' });
      await panel.getByRole('button', { name: 'Test', exact: true }).click();
      await panel.getByText('Tested in the simulator. No Mac actions were performed.', { exact: true }).waitFor();
      assert.equal(await panel.getByLabel('Prompt execution', { exact: true }).count(), 0);
      await waitFor(async () => {
        const config = JSON.parse(await readFile(join(profile.dataDir, 'config.json'), 'utf8')) as Config;
        return config.profiles.some(p => Object.values(p.pages).some(page => page.keys.some(k => k?.settings.prompt === `${savedPrompt}\nKeep files unchanged.`)));
      }, 3000, 'prompt edit persisted');
    }
    await page.reload();
    await waitForEditor(page);
    await page.locator('#deck-key-0').click();
    await panel.getByRole('heading', { name: 'Codex review', exact: true }).waitFor();
  } finally { await profile.cleanup(); }
});
