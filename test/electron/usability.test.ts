import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { findPage, launchApp, makeProfile, waitForEditor } from './helpers.ts';
import type { Config } from '../../src/shared/types.ts';

test('first-run simulator setup leads to a complete manual key workflow at minimum window size', { timeout: 60_000 }, async () => {
  const profile = await makeProfile({ prefs: { aiProvider: 'api', openAtLogin: false } });
  try {
    const app = await launchApp(profile);
    const onboarding = await findPage(app, 'onboarding');
    const errors: string[] = [];
    onboarding.on('pageerror', e => errors.push(e.message));
    await onboarding.getByRole('button', { name: 'Get Started' }).click();
    await onboarding.getByRole('button', { name: 'Use Simulator' }).click();
    await onboarding.getByRole('heading', { name: "You're set." }).waitFor();
    await onboarding.getByRole('button', { name: 'Back', exact: true }).click();
    await onboarding.getByRole('button', { name: 'Use Simulator' }).click();
    await onboarding.getByRole('button', { name: 'Open StreamDeckPlus' }).click();

    const page = await findPage(app, 'editor');
    page.on('pageerror', e => errors.push(e.message));
    page.setDefaultTimeout(7500);
    await waitForEditor(page);
    await page.waitForFunction(() => {
      const segments = Array.from(document.querySelectorAll<HTMLImageElement>('.strip img'));
      return segments.length === 4 && segments.every(img => img.complete && img.naturalWidth > 0);
    });
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows().find(w => new URL(w.webContents.getURL()).search === '')?.setContentSize(960, 620);
    });
    await page.waitForFunction(() => innerWidth === 960 && innerHeight === 620);
    assert.ok(await page.evaluate(() => {
      const deck = document.querySelector('.deck-studio')!.getBoundingClientRect();
      const editor = document.querySelector('#key-workspace')!.getBoundingClientRect();
      const work = document.querySelector('.studio-work')!.getBoundingClientRect();
      return editor.left >= deck.right && editor.top >= work.top && editor.bottom <= work.bottom && deck.top >= work.top && deck.bottom <= work.bottom;
    }), 'both the deck and the key workspace fit at the minimum Electron window size');
    const panelBounds = () => page.evaluate(() => {
      const panel = document.querySelector('#key-workspace')!.getBoundingClientRect();
      return [panel.x, panel.y, panel.width];
    });
    const homeBounds = await panelBounds();
    await page.getByRole('heading', { name: 'Create or edit with AI' }).waitFor();
    await page.getByRole('heading', { name: 'Preset button groups' }).waitFor();

    await page.getByRole('button', { name: 'Add page', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Blank page', exact: true }).click();
    await page.getByRole('button', { name: 'Key 1: empty', exact: true }).click();
    await page.getByRole('button', { name: 'Set up AI…', exact: true }).waitFor();
    assert.equal(await page.getByRole('textbox', { name: 'Create with AI' }).count(), 0);
    assert.deepEqual(await panelBounds(), homeBounds);
    await page.getByRole('button', { name: 'Set up manually', exact: true }).click();
    const library = page.getByRole('complementary', { name: 'Action library' });
    await library.getByRole('button', { name: 'Mac', exact: true }).click();
    await library.getByRole('heading', { name: 'Choose an action', exact: true }).waitFor();
    assert.deepEqual(await panelBounds(), homeBounds);
    const search = page.getByRole('textbox', { name: 'Search actions' });
    await search.fill('screenshot');
    await search.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Screenshot tools' });
    await dialog.getByRole('button', { name: 'Choose icon…', exact: true }).click();
    await dialog.getByRole('textbox', { name: 'Search icons' }).fill('aperture');
    await dialog.getByRole('button', { name: 'aperture', exact: true }).click();
    await dialog.getByRole('textbox', { name: 'Button label' }).fill('Capture Screen');
    await dialog.getByRole('combobox', { name: 'Control', exact: true }).selectOption('screenshot');
    await dialog.getByRole('button', { name: /^Add to Key 1/ }).click();
    await page.getByRole('heading', { name: 'Capture Screen', exact: true }).waitFor();
    assert.deepEqual(await panelBounds(), homeBounds);
    const config = JSON.parse(await readFile(join(profile.dataDir, 'config.json'), 'utf8')) as Config;
    const action = Object.values(config.profiles[0]!.pages).find(p => p.keys[0]?.appearance.title === 'Capture Screen')?.keys[0];
    assert.deepEqual(action?.appearance.icon, { kind: 'lucide', name: 'aperture' });
    assert.equal(action?.settings.op, 'screenshot');

    await page.getByRole('button', { name: 'Test', exact: true }).click();
    await page.getByText('Tested in the simulator. No Mac actions were performed.', { exact: true }).waitFor();
    await page.getByRole('radio', { name: 'Use', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: 'Add page', exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Delete page', exact: true }).count(), 0);
    await page.getByRole('button', { name: '1 Main', exact: true }).click();
    await page.getByRole('button', { name: '1 Main', exact: true }).and(page.locator('[aria-current="page"]')).waitFor();
    await page.getByRole('radio', { name: 'Edit', exact: true }).click();
    const presets = page.getByRole('region', { name: 'Preset button groups' });
    await presets.getByRole('button', { name: 'Media', exact: true }).click();
    await page.getByRole('button', { name: /\d+ Media/ }).and(page.locator('[aria-current="page"]')).waitFor();
    await page.getByRole('button', { name: '1 Main', exact: true }).click();
    await page.getByRole('button', { name: 'Key 1: Play', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Add page', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Blank page', exact: true }).click();
    await page.getByRole('button', { name: 'Key 1: empty', exact: true }).waitFor();
    const blankPage = await page.locator('nav [aria-current="page"]').innerText();
    await presets.getByRole('button', { name: 'Everyday Mac', exact: true }).click();
    await page.getByText('Everyday Mac buttons added', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Key 1: empty', exact: true }).waitFor({ state: 'detached' });
    assert.equal(await page.locator('nav [aria-current="page"]').innerText(), blankPage);
    assert.deepEqual(errors, []);
  } finally {
    await profile.cleanup();
  }
});

test('the deck stays centered while key options scroll independently', { timeout: 60_000 }, async () => {
  const profile = await makeProfile({ prefs: { onboarded: true, showInMenuBar: false, aiProvider: 'api', openAtLogin: false } });
  try {
    const app = await launchApp(profile);
    const page = await findPage(app, 'editor');
    await waitForEditor(page);
    page.setDefaultTimeout(7500);
    const panel = page.getByRole('complementary', { name: 'Key workspace' });
    const deck = page.getByRole('region', { name: 'Your deck' });

    for (const [width, height] of [[1280, 820], [960, 620]] as const) {
      await app.evaluate(({ BrowserWindow }, { width, height }) => {
        BrowserWindow.getAllWindows().find(w => new URL(w.webContents.getURL()).search === '')?.setContentSize(width, height);
      }, { width, height });
      await page.waitForFunction(({ width, height }) => innerWidth === width && innerHeight === height, { width, height });
      await page.locator('#deck-key-0').click();
      const options = panel.locator('details').filter({ has: page.locator('summary', { hasText: /^More key options$/ }) });
      await options.locator(':scope > summary').click();
      const before = await deck.boundingBox();
      assert.ok(before);
      assert.ok(await deck.evaluate(el => {
        const box = el.getBoundingClientRect();
        const layout = el.parentElement!;
        const parent = layout.getBoundingClientRect();
        const style = getComputedStyle(layout);
        const center = (parent.top + parseFloat(style.paddingTop) + parent.bottom - parseFloat(style.paddingBottom)) / 2;
        return Math.abs(box.top + box.height / 2 - center) < 1;
      }), 'the deck is vertically centered in the workspace');

      const panelBox = await panel.boundingBox();
      assert.ok(panelBox);
      await page.mouse.move(panelBox.x + panelBox.width - 20, panelBox.y + 50);
      await page.mouse.wheel(0, 650);
      await page.waitForFunction(() => document.getElementById('key-workspace')!.scrollTop > 0);
      assert.deepEqual(await deck.boundingBox(), before, 'scrolling the sidebar does not move the deck');
      assert.equal(await page.locator('.studio-work').evaluate(el => el.scrollTop), 0);
      await panel.getByRole('heading', { name: 'Changes with your Mac', exact: true }).scrollIntoViewIfNeeded();
      assert.deepEqual(await deck.boundingBox(), before, 'the bottom settings remain reachable without moving the deck');
      await page.mouse.wheel(0, 3000);
      assert.deepEqual(await deck.boundingBox(), before, 'scrolling beyond the sidebar does not scroll the workspace');
      await page.locator('#deck-key-1').click();
      await page.waitForFunction(() => document.getElementById('key-workspace')!.scrollTop === 0);
    }
  } finally {
    await profile.cleanup();
  }
});
