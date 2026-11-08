// Offline data recovery: writes a separate, verified copy of a data directory. The source is read only.
// Used by `npm run recover` and by the desktop app's Repair button.
import { copyFileSync, existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Config } from '../shared/types.ts';
import { Store } from './store.ts';
import { recoverProfile } from './profile-recovery.ts';

export interface RecoveryResult { profiles: number; changes: number; output: string }

export function recoverDataDir(sourceDir: string, outputDir: string): RecoveryResult {
  const source = resolve(sourceDir);
  const output = resolve(outputDir);
  if (existsSync(output)) throw new Error('Choose a new output directory.');
  const bytes = readFileSync(join(source, 'config.json'));
  let config: Config;
  try { config = JSON.parse(bytes.toString('utf8')) as Config; }
  catch { throw new Error('The settings file is damaged beyond repair. Start Fresh keeps the old folder and starts over.'); }
  if (!Array.isArray(config?.profiles) || !config.profiles.length) {
    throw new Error('The settings file has no profiles to recover. Start Fresh keeps the old folder and starts over.');
  }
  const recovered = config.profiles.map(recoverProfile);
  config.profiles = recovered.map(result => result.profile);

  const staged = mkdtempSync(join(dirname(output), '.osb-recovery-'));
  try {
    writeFileSync(join(staged, 'config.original.json'), bytes, { flag: 'wx', mode: 0o600 });
    writeFileSync(join(staged, 'config.json'), JSON.stringify(config, null, 2), { flag: 'wx', mode: 0o600 });
    const store = new Store(staged, true); // Verify through the same loader used on startup.
    const images = join(source, 'images');
    if (existsSync(images) && lstatSync(images).isDirectory()) {
      for (const file of readdirSync(images)) {
        if (!/^[0-9a-f]{20}\.(png|jpe?g|gif|webp|svg)$/.test(file)) continue;
        const path = join(images, file);
        if (lstatSync(path).isFile()) copyFileSync(path, join(store.imagesDir, file));
      }
    }
    if (existsSync(output)) throw new Error('The output directory was created during recovery. Choose a new output directory.');
    renameSync(staged, output);
  } finally { rmSync(staged, { recursive: true, force: true }); }
  return { profiles: recovered.length, changes: recovered.reduce((total, result) => total + result.changes, 0), output };
}
