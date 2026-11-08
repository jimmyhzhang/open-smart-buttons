import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appDataDir, appSetting, desktopUserDataDir, isAppEnvironmentVariable, LEGACY_APP_NAME, profileDirectoryArg } from '../src/engine/app-compat.ts';
import { migrateBrowserPreferences } from '../ui/src/legacy-preferences.ts';

test('fresh storage uses the new identity; legacy stores are reused without copying or overwriting newer data', t => {
  const home = mkdtempSync(join(tmpdir(), 'osb-compat-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const current = join(home, '.open-smart-buttons');
  const legacy = join(home, '.streamdeckplus');
  assert.equal(appDataDir({}, home), current);
  mkdirSync(legacy);
  writeFileSync(join(legacy, 'config.json'), 'original');
  writeFileSync(join(legacy, 'server.lock'), String(process.pid));
  assert.equal(appDataDir({}, home), legacy, 'both versions must use the same service lock');
  assert.equal(readFileSync(join(legacy, 'config.json'), 'utf8'), 'original');
  mkdirSync(current);
  writeFileSync(join(current, 'config.json'), 'newer');
  assert.equal(appDataDir({}, home), current);
  assert.equal(readFileSync(join(current, 'config.json'), 'utf8'), 'newer');
  assert.equal(appDataDir({ STREAMDECKPLUS_DATA: '/old-explicit' }, home), '/old-explicit');
  assert.equal(appDataDir({ OPEN_SMART_BUTTONS_DATA: '/new-explicit', STREAMDECKPLUS_DATA: '/old-explicit' }, home), '/new-explicit');

  const support = join(home, 'Application Support');
  const oldPrefs = join(support, LEGACY_APP_NAME);
  const newPrefs = join(support, 'Open Smart Buttons');
  assert.equal(desktopUserDataDir(support), newPrefs);
  mkdirSync(oldPrefs, { recursive: true });
  writeFileSync(join(oldPrefs, 'prefs.json'), '{"theme":"dark"}');
  writeFileSync(join(oldPrefs, 'anthropic-key.bin'), 'encrypted-only-fixture');
  assert.equal(desktopUserDataDir(support), oldPrefs);
  mkdirSync(newPrefs);
  assert.equal(desktopUserDataDir(support), newPrefs, 'a new preference folder is never overwritten');
  assert.equal(readFileSync(join(oldPrefs, 'anthropic-key.bin'), 'utf8'), 'encrypted-only-fixture');
});

test('canonical environment settings win over legacy aliases and all app namespaces are private to child tools', () => {
  for (const [key, old] of [['AI', 'STREAMDECK_AI'], ['CLAUDE_MODEL', 'STREAMDECK_CLAUDE_MODEL'], ['LOCAL_ONLY', 'STREAMDECK_LOCAL_ONLY']] as const) {
    assert.equal(appSetting(key, { [old]: 'legacy' }), 'legacy');
    assert.equal(appSetting(key, { [old]: 'legacy', [`OPEN_SMART_BUTTONS_${key}`]: 'current' }), 'current');
    assert.equal(appSetting(key, { [old]: 'legacy', [`OPEN_SMART_BUTTONS_${key}`]: '' }), '');
    assert.equal(isAppEnvironmentVariable(old), true);
    assert.equal(isAppEnvironmentVariable(`OPEN_SMART_BUTTONS_${key}`), true);
  }
  assert.equal(isAppEnvironmentVariable('STREAMDECKPLUS_DATA'), true);
  assert.equal(isAppEnvironmentVariable('OSB_SIGN_IDENTITY'), true);
  assert.equal(isAppEnvironmentVariable('MY_SCRIPT_VAR'), false);
});

test('browser preferences migrate once without copying session credentials or replacing current choices', () => {
  const values = new Map([
    ['sdp.theme', 'dark'], ['sdp.mode', 'use'], ['sdp.device', 'neo'], ['sdp.settings.tab', 'ai'],
    ['sdp-session', 'old-credential'], ['osb.theme', 'light'],
  ]);
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  migrateBrowserPreferences(storage);
  assert.equal(values.get('osb.theme'), 'light');
  assert.equal(values.get('osb.mode'), 'use');
  assert.equal(values.get('osb.device'), 'neo');
  assert.equal(values.get('osb.settings.tab'), 'ai');
  assert.equal(values.has('osb-session'), false);
  values.set('sdp.mode', 'edit');
  migrateBrowserPreferences(storage);
  assert.equal(values.get('osb.mode'), 'use');
  assert.doesNotThrow(() => migrateBrowserPreferences({ getItem: () => { throw new Error('Storage blocked'); }, setItem: () => {} }));
});

test('old isolated-profile flags remain isolated and empty paths cannot fall through to personal data', () => {
  assert.equal(profileDirectoryArg(['--sdp-profile-dir=/old-fixture']), '/old-fixture');
  assert.equal(profileDirectoryArg(['--osb-profile-dir=/new-fixture', '--sdp-profile-dir=/old-fixture']), '/new-fixture');
  assert.equal(profileDirectoryArg([]), undefined);
  assert.throws(() => profileDirectoryArg(['--osb-profile-dir=']), /must not be empty/);
  assert.throws(() => profileDirectoryArg(['--sdp-profile-dir=   ']), /must not be empty/);
});
