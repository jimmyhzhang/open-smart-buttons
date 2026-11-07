import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page, Locator } from 'playwright-core';
import { CATALOG } from '../../src/engine/actions.ts';
import { Store, starterProfile } from '../../src/engine/store.ts';
import { actionChoices, type ActionChoice } from '../../src/shared/action-presets.ts';
import { STARTER_LAYOUTS } from '../../src/shared/starter-layouts.ts';
import type { Config } from '../../src/shared/types.ts';
import { findPage, launchApp, makeProfile, waitFor, waitForEditor } from './helpers.ts';

const LABELS: Record<string, string> = {
  'system.open': 'Open an app or file',
  'system.hotkey': 'Send a keyboard shortcut',
  'system.script': 'Run a script',
};

async function openAction(page: Page, choice: ActionChoice): Promise<Locator> {
  await page.getByRole('button', { name: 'Set up manually', exact: true }).click();
  const library = page.getByRole('complementary', { name: 'Action library' });
  const label = LABELS[choice.id] ?? choice.name;
  await library.getByRole('textbox', { name: 'Search actions' }).fill(label);
  let row = library.locator('.picker-item').filter({ has: page.getByText(label, { exact: true }) });
  if (choice.name === 'Sleep') row = row.filter({ hasText: choice.description });
  await row.first().click();
  const dialog = page.getByRole('dialog');
  await dialog.waitFor();
  return dialog;
}

async function visibleField(dialog: Locator, key: string): Promise<Locator> {
  const control = dialog.locator(`[id^="f-${key}-"]`).first();
  if (!await control.isVisible()) {
    const disclosure = control.locator('xpath=ancestor::details[not(@open)][1]');
    await disclosure.locator(':scope > summary').click();
  }
  return control;
}

async function completeKey(page: Page, dialog: Locator, choice: ActionChoice, script: string, project: string) {
  const meta = CATALOG.find(meta => meta.type === choice.type)!;
  const settings = { ...meta.defaults, ...choice.settings };
  const fill = async (key: string, value: string) => (await visibleField(dialog, key)).fill(value);
  if (choice.type.startsWith('agent.')) {
    await fill('cwd', project);
    if (settings.execution === 'background') await fill('prompt', 'Explain this project without changing any files.');
  }
  switch (choice.type) {
    case 'system.script':
      await fill('path', script);
      await dialog.getByText('Script file checked.', { exact: true }).waitFor();
      break;
    case 'system.website':
      if (!settings.url) await fill('url', 'https://example.invalid');
      break;
    case 'system.open':
      if (!settings.path) await fill('path', project);
      break;
    case 'system.shortcut':
      if (!settings.name) await fill('name', 'Preset audit shortcut');
      break;
    case 'system.raycast':
      await fill('url', 'raycast://extensions/test/test/probe');
      break;
    case 'system.asyar':
      await fill('url', 'asyar://extensions/test/test/probe');
      break;
    case 'system.text':
      if (!settings.text) await fill('text', 'Preset audit text');
      break;
    case 'system.command':
      if (!settings.command) await fill('command', 'printf preset-probe');
      break;
    case 'system.hotkey':
      if (!settings.hotkey) {
        await dialog.getByRole('button', { name: /^Shortcut: / }).click();
        await page.keyboard.press('Meta+Shift+K');
      }
      break;
    case 'sd.page.goto':
      await (await visibleField(dialog, 'pageId')).selectOption({ index: 1 });
      break;
    case 'sd.profile':
      await (await visibleField(dialog, 'profileId')).selectOption({ index: 1 });
      break;
    case 'sd.multi':
      await dialog.getByRole('button', { name: 'Add step', exact: true }).click();
      await dialog.getByRole('combobox', { name: 'Step 1 action' }).selectOption('util.counter');
      break;
  }
}

test('every key preset and catalog action can be created and edited in Electron', { timeout: 120_000 }, async t => {
  const profile = await makeProfile({
    prefs: { onboarded: true, showInMenuBar: false, aiProvider: 'api', openAtLogin: false },
    setup(dataDir) {
      const store = new Store(dataDir);
      const alternate = starterProfile('plus');
      alternate.name = 'Another profile';
      store.config.profiles.push(alternate);
      store.flush();
    },
  });
  try {
    const script = join(profile.dir, 'probe.sh');
    await writeFile(script, '#!/bin/bash\n# @raycast.title Preset probe\nprintf "preset-probe\\n"\n', { mode: 0o700 });
    const app = await launchApp(profile);
    const page = await findPage(app, 'editor');
    await waitForEditor(page);
    page.setDefaultTimeout(7500);
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows().find(w => new URL(w.webContents.getURL()).search === '')?.setContentSize(960, 620);
    });
    await page.locator('#deck-key-0').click();
    const readConfig = async () => JSON.parse(await readFile(join(profile.dataDir, 'config.json'), 'utf8')) as Config;
    const initial = (await readConfig()).profiles[0]!;
    const saved = async () => (await readConfig()).profiles.find(p => p.id === initial.id)!.pages[initial.pageOrder[0]!]!.keys[0]!;
    const panel = page.getByRole('complementary', { name: 'Key workspace' });
    const choices = actionChoices(CATALOG.filter(meta => meta.controllers.includes('key')));
    // A folder is replaced only through its explicit removal flow, so exercise its setup last.
    choices.sort((a, b) => Number(a.type === 'sd.folder') - Number(b.type === 'sd.folder'));

    for (const choice of choices) {
      await t.test(choice.id, async () => {
        const dialog = await openAction(page, choice);
        await completeKey(page, dialog, choice, script, profile.dir);
        const title = `QA ${choice.id}`;
        await dialog.getByRole('textbox', { name: 'Button label', exact: true }).fill(title);
        await dialog.getByRole('combobox', { name: 'Target button' }).selectOption('key:0');
        await dialog.locator('.setup-actions .primary').click();
        try { await dialog.waitFor({ state: 'detached' }); }
        catch (error) {
          const errors = await dialog.getByRole('alert').allTextContents();
          throw new Error(`${choice.id} setup failed. ${errors.join(' ')}`, { cause: error });
        }
        await waitFor(async () => (await saved()).appearance.title === title, 3000, 'preset saved');
        const created = await saved();
        assert.equal(created.type, choice.type);
        for (const [key, value] of Object.entries(choice.settings)) {
          if (value === '' || value === null || value === undefined || key === 'folderId' ||
            ['system.raycast', 'system.asyar'].includes(choice.type)) continue;
          assert.deepEqual(created.settings[key], value, `${choice.id} retains its ${key} preset`);
        }
        await panel.getByRole('button', { name: 'Configure', exact: true }).click();
        const editing = page.getByRole('dialog');
        const label = editing.getByRole('textbox', { name: 'Button label', exact: true });
        if (!await label.isVisible()) await editing.getByText('Icon & label', { exact: true }).click();
        await label.fill(`Edited ${choice.id}`);
        await editing.getByRole('button', { name: /^Save changes/ }).click();
        await editing.waitFor({ state: 'detached' });
        await waitFor(async () => (await saved()).appearance.title === `Edited ${choice.id}`, 3000, 'preset edited');
        assert.deepEqual((await saved()).settings, created.settings, 'editing the label preserves the configured action');
        if (/^(system\.|agent\.)/.test(choice.type) || ['util.awake', 'util.counter', 'util.toggle'].includes(choice.type)) {
          await panel.getByRole('button', { name: 'Test', exact: true }).click();
          await panel.getByText('Tested in the simulator. No Mac actions were performed.', { exact: true }).waitFor();
        }
      });
      const dialog = page.getByRole('dialog');
      if (await dialog.count()) await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
      const close = page.getByRole('button', { name: 'Close manual setup', exact: true });
      if (await close.count()) await close.click();
    }
  } finally {
    await profile.cleanup();
  }
});

test('dial setup requires an operation and supports every dial action', { timeout: 60_000 }, async t => {
  const profile = await makeProfile({ prefs: { onboarded: true, showInMenuBar: false, aiProvider: 'api' } });
  try {
    const app = await launchApp(profile);
    const page = await findPage(app, 'editor');
    await waitForEditor(page);
    page.setDefaultTimeout(5000);
    await page.getByRole('spinbutton', { name: /^Dial 1:/ }).click();
    const choices = actionChoices(CATALOG.filter(meta => meta.controllers.includes('dial'))).filter(choice => choice.id === choice.type);
    for (const choice of choices) {
      await t.test(choice.id, async () => {
        await page.getByRole('button', { name: '1 Main', exact: true }).click();
        await page.getByRole('spinbutton', { name: /^Dial 1:/ }).click();
        const dialog = await openAction(page, choice);
        if (['system.hotkey', 'system.command'].includes(choice.type)) {
          await dialog.locator('.setup-actions .primary').click();
          await dialog.getByRole('alert').filter({ hasText: 'at least one dial control' }).waitFor();
          const left = await visibleField(dialog, 'left');
          if (choice.type === 'system.hotkey') {
            await left.click();
            await page.keyboard.press('Meta+Shift+K');
          } else await left.fill('printf dial-probe');
        }
        await dialog.getByRole('combobox', { name: 'Target button' }).selectOption('dial:0');
        await dialog.locator('.setup-actions .primary').click();
        await dialog.waitFor({ state: 'detached' });
        await waitFor(async () => {
          const config = JSON.parse(await readFile(join(profile.dataDir, 'config.json'), 'utf8')) as Config;
          const first = config.profiles[0]!;
          return first.pages[first.pageOrder[0]!]!.dials[0]?.type === choice.type;
        }, 3000, 'dial action saved');
        for (const direction of ['ArrowLeft', 'ArrowRight']) {
          await page.getByRole('spinbutton', { name: /^Dial 1:/ }).press(direction);
          if (choice.type === 'sd.page.indicator') {
            await page.getByRole('button', { name: '2 Page 2', exact: true }).and(page.locator('[aria-current="page"]')).waitFor();
            await page.getByRole('button', { name: '1 Main', exact: true }).click();
            await page.getByRole('button', { name: '1 Main', exact: true }).and(page.locator('[aria-current="page"]')).waitFor();
          }
        }
        await page.getByRole('spinbutton', { name: /^Dial 1:/ }).press('Enter');
      });
    }
  } finally {
    await profile.cleanup();
  }
});

test('Switch Profile creates its missing destination within the setup dialog', { timeout: 30_000 }, async () => {
  const profile = await makeProfile({ prefs: { onboarded: true, showInMenuBar: false, aiProvider: 'api' } });
  try {
    const app = await launchApp(profile);
    const page = await findPage(app, 'editor');
    await waitForEditor(page);
    await page.locator('#deck-key-0').click();
    const choice = actionChoices(CATALOG).find(choice => choice.id === 'sd.profile')!;
    const dialog = await openAction(page, choice);
    const select = dialog.getByRole('combobox', { name: 'Profile', exact: true });
    assert.equal(await select.isDisabled(), true);
    await dialog.getByRole('button', { name: 'Create a profile', exact: true }).click();
    await waitFor(() => select.isEnabled(), 5000, 'new profile available');
    const destination = await select.inputValue();
    assert.ok(destination);
    await dialog.locator('.setup-actions .primary').click();
    await dialog.waitFor({ state: 'detached' });
    const config = JSON.parse(await readFile(join(profile.dataDir, 'config.json'), 'utf8')) as Config;
    assert.equal(config.profiles[0]!.pages[config.profiles[0]!.pageOrder[0]!]!.keys[0]!.settings.profileId, destination);
    assert.ok(config.profiles.some(p => p.id === destination && p.modelId === 'plus'));
  } finally {
    await profile.cleanup();
  }
});

test('every preset button group fills an empty page and can be undone on Plus and Neo', { timeout: 60_000 }, async t => {
  const profile = await makeProfile({
    prefs: { onboarded: true, showInMenuBar: false, aiProvider: 'api' },
    setup(dataDir) { new Store(dataDir).flush(); },
  });
  try {
    const app = await launchApp(profile);
    const page = await findPage(app, 'editor');
    await waitForEditor(page);
    page.setDefaultTimeout(5000);
    const config = async () => JSON.parse(await readFile(join(profile.dataDir, 'config.json'), 'utf8')) as Config;
    for (const modelId of ['plus', 'neo']) {
      if (modelId === 'neo') {
        await page.locator('.topbar button.chip').first().click();
        await page.getByText('Simulator and diagnostics', { exact: true }).click();
        await page.getByRole('button', { name: 'Simulate Neo', exact: true }).click();
        await page.locator('.deck-studio-header').getByRole('heading', { name: 'Stream Deck Neo', exact: true }).waitFor();
      }
      await waitFor(async () => (await config()).profiles.some(p => p.modelId === modelId), 3000, 'device profile persisted');
      for (const layout of STARTER_LAYOUTS) {
        await t.test(`${modelId} ${layout.id}`, async () => {
          const previous = (await config()).profiles.find(p => p.modelId === modelId)!;
          await page.getByRole('button', { name: 'Add page', exact: true }).click();
          await page.getByRole('menuitem', { name: 'Blank page', exact: true }).click();
          await page.getByRole('button', { name: 'Key 1: empty', exact: true }).waitFor();
          await waitFor(async () => (await config()).profiles.find(p => p.id === previous.id)!.pageOrder.length === previous.pageOrder.length + 1,
            3000, 'blank page persisted');
          const current = (await config()).profiles.find(p => p.modelId === modelId)!;
          const pageId = current.pageOrder.at(-1)!;
          const groups = page.getByRole('region', { name: 'Preset button groups' });
          await groups.getByRole('button', { name: layout.name, exact: true }).click();
          await page.getByText(`${layout.name} buttons added`, { exact: true }).waitFor();
          await waitFor(async () => {
            const saved = (await config()).profiles.find(p => p.id === current.id)!;
            return saved.pages[pageId]!.keys.some(Boolean);
          }, 3000, 'preset group saved');
          const saved = (await config()).profiles.find(p => p.id === current.id)!;
          assert.equal(saved.pageOrder.length, current.pageOrder.length, 'an empty page is filled in place');
          const choices = new Map(actionChoices(CATALOG).map(choice => [choice.id, choice]));
          for (const [index, action] of saved.pages[pageId]!.keys.entries()) {
            const preset = choices.get(layout.keys[index]!);
            if (preset) {
              assert.ok(action);
              assert.equal(action.type, preset.type);
              for (const [key, value] of Object.entries(preset.settings)) assert.deepEqual(action.settings[key], value);
            }
          }
          await page.locator('.toast').filter({ hasText: `${layout.name} buttons added` }).getByRole('button', { name: 'Undo', exact: true }).click();
          await waitFor(async () => {
            const cleared = (await config()).profiles.find(p => p.id === current.id)!.pages[pageId]!;
            return [...cleared.keys, ...cleared.dials].every(action => !action);
          }, 5000, 'group undo cleared only the added buttons');
        });
      }
    }
  } finally {
    await profile.cleanup();
  }
});
