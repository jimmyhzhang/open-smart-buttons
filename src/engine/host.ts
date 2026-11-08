// Host conveniences for the setup UI: native file/folder/app pickers, installed-app
// suggestions and real app icons. These never perform a button's action, so they work
// the same with "Dry run" on.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { exec, type CommandRunner } from './platform.ts';

export type PickKind = 'folder' | 'file' | 'app';
export interface InstalledApp { name: string; path: string }

/** Reads names for setup. Shortcuts are only executed through the action runner. */
export async function listShortcutNames(run: CommandRunner = exec): Promise<string[]> {
  const result = await run('/usr/bin/shortcuts', ['list'], 3000);
  if (result.code !== 0) throw new Error('Shortcuts could not be listed. Enter the shortcut name manually.');
  return [...new Set(result.stdout.split(/\r?\n/).map((name) => name.trim()).filter((name) => name && !name.startsWith('-') && !name.includes('\0')))].slice(0, 1000);
}

const PICK_TIMEOUT = 10 * 60_000;

/** "~/x" for paths in the home folder, so buttons stay readable and portable. */
export function tildePath(path: string, home = homedir()): string {
  const clean = path.length > 1 ? path.replace(/\/+$/, '') : path;
  return clean === home ? '~' : clean.startsWith(`${home}/`) ? `~${clean.slice(home.length)}` : clean;
}

function appleString(s: string): string {
  return `"${s.replace(/[\\"]/g, (c) => `\\${c}`).replace(/\s*[\r\n]+\s*/g, ' ')}"`;
}

/** Shows the macOS chooser. Resolves to null when the user cancels. */
export async function chooseOnMac(kind: PickKind, prompt: string, run: CommandRunner = exec): Promise<string | null> {
  const p = appleString(prompt.slice(0, 120) || 'Choose');
  const pick = kind === 'folder' ? `choose folder with prompt ${p}`
    : kind === 'file' ? `choose file with prompt ${p}`
    : `choose application with prompt ${p} as alias`;
  // `activate` brings the chooser in front of the browser without needing Automation rights.
  const r = await run('osascript', ['-e', 'activate', '-e', `POSIX path of (${pick})`], PICK_TIMEOUT);
  if (r.code !== 0) {
    if (/-128|User canceled/i.test(r.stderr)) return null;
    throw new Error(r.stderr.trim() || 'The macOS chooser failed to open');
  }
  const out = r.stdout.trim();
  if (!out) return null;
  return kind === 'app' ? out.replace(/\/+$/, '') : tildePath(out);
}

const APP_DIRS = ['/Applications', '/Applications/Utilities', '/System/Applications', '/System/Applications/Utilities', join(homedir(), 'Applications')];

/** Installed .app bundles, de-duplicated by name, sorted A–Z. */
export function listInstalledApps(dirs = APP_DIRS): InstalledApp[] {
  const seen = new Map<string, InstalledApp>();
  for (const dir of dirs) {
    let names: string[] = [];
    try { names = readdirSync(dir); } catch { continue; }
    for (const n of names) {
      if (!n.endsWith('.app') || n.startsWith('.')) continue;
      const name = n.slice(0, -4);
      if (!seen.has(name.toLowerCase())) seen.set(name.toLowerCase(), { name, path: join(dir, n) });
    }
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

/** Resolves "Safari", "Safari.app" or a path to the bundle path, when installed. */
export function resolveApp(nameOrPath: string, apps = listInstalledApps()): string | null {
  const v = nameOrPath.trim();
  if (!v) return null;
  if (v.startsWith('/') && v.replace(/\/+$/, '').endsWith('.app')) return existsSync(v) ? v.replace(/\/+$/, '') : null;
  const want = v.replace(/\.app$/i, '').toLowerCase();
  return apps.find((a) => a.name.toLowerCase() === want)?.path ?? null;
}

/** PNG bytes of an app's icon (128 px), using sips. Null when the app has no .icns icon. */
export async function appIconPng(appPath: string, run: CommandRunner = exec): Promise<Uint8Array | null> {
  if (!appPath.endsWith('.app') || !existsSync(join(appPath, 'Contents'))) return null;
  const plist = join(appPath, 'Contents', 'Info.plist');
  const r = await run('/usr/bin/plutil', ['-extract', 'CFBundleIconFile', 'raw', '-o', '-', plist]);
  // Only a file name inside Resources is accepted (never a path out of the bundle).
  let icon = r.code === 0 ? basename(r.stdout.trim()) : '';
  const resources = join(appPath, 'Contents', 'Resources');
  if (icon && !icon.endsWith('.icns')) icon += '.icns';
  if (!icon || !existsSync(join(resources, icon))) {
    // Some apps (asset-catalog only) name the file AppIcon.icns or nothing at all.
    let found: string | undefined;
    try { found = readdirSync(resources).find((f) => f.endsWith('.icns') && /appicon|app\.icns|icon\.icns/i.test(f)) ?? readdirSync(resources).find((f) => f.endsWith('.icns')); } catch { /* none */ }
    if (!found) return null;
    icon = found;
  }
  const dir = join(tmpdir(), 'open-smart-buttons-icons');
  mkdirSync(dir, { recursive: true });
  const out = join(dir, `${basename(appPath, '.app').replace(/[^\w.-]+/g, '_')}-${Date.now()}.png`);
  const s = await run('/usr/bin/sips', ['-s', 'format', 'png', '-Z', '128', join(resources, icon), '--out', out], 20_000);
  if (s.code !== 0 || !existsSync(out)) return null;
  try { return readFileSync(out); } finally { rmSync(out, { force: true }); }
}
