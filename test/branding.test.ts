import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { APP_NAME, APP_ID, PACKAGE_NAME } from '../src/shared/brand.ts';

test('public identity and package metadata stay aligned; old application branding is confined to compatibility code', async () => {
  assert.equal(APP_NAME, 'Open Smart Buttons');
  assert.equal(APP_ID, 'ai.readingplus.opensmartbuttons');
  assert.equal(PACKAGE_NAME, 'open-smart-buttons');
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
  assert.equal(pkg.name, PACKAGE_NAME);
  assert.equal(lock.name, PACKAGE_NAME);
  assert.equal(lock.packages[''].name, PACKAGE_NAME);
  const config = (await import(new URL('../electron-builder.config.mjs', import.meta.url).href)).default;
  assert.equal(config.productName, APP_NAME);
  assert.equal(config.appId, APP_ID);
  assert.equal(config.mac.artifactName, 'open-smart-buttons-${version}-${arch}.${ext}');
  const allowed = new Set(['src/engine/app-compat.ts', 'ui/src/legacy-preferences.ts']);
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      const file = join(dir, item.name);
      if (file === 'ui/dist') continue;
      if (item.isDirectory()) walk(file);
      else if (/\.(?:ts|tsx|js|cjs|html|css)$/.test(file)) files.push(file);
    }
  };
  for (const dir of ['src', 'ui/src', 'electron', 'scripts']) walk(dir);
  const old = /StreamDeckPlus|streamdeckplus|STREAMDECK(?:PLUS)?_|sdpNative|\bsdp[-.:]|\.sdplus\.json/;
  const remaining = files.filter(file => !allowed.has(file) && old.test(readFileSync(file, 'utf8')));
  assert.deepEqual(remaining, []);
  for (const file of ['README.md', 'CHANGELOG.md', 'SECURITY.md', 'THIRD_PARTY_NOTICES.md', 'ui/index.html']) {
    assert.equal(old.test(readFileSync(file, 'utf8')), false, file);
  }
});
