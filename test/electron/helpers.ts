// Shared helpers for the Electron end-to-end suite: launch the dev app on an isolated profile with a
// simulated deck, find its windows, read the service's files, and always clean up.

import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../../', import.meta.url));
const electronBinary = createRequire(import.meta.url)('electron') as unknown as string;

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Polls `fn` until it returns a truthy value, or fails with `message` after `ms`. */
export async function waitFor<T>(fn: () => T | Promise<T>, ms: number, message: string, every = 50): Promise<NonNullable<T>> {
  const deadline = Date.now() + ms;
  let last: unknown;
  for (;;) {
    try {
      const value = await fn();
      if (value) return value as NonNullable<T>;
    } catch (error) { last = error; }
    if (Date.now() > deadline) throw new Error(`${message}${last ? ` (last error: ${(last as Error).message ?? last})` : ''}`);
    await sleep(every);
  }
}

export async function freePort(): Promise<number> {
  const lease = createServer();
  await new Promise<void>((resolve, reject) => { lease.once('error', reject); lease.listen(0, '127.0.0.1', () => resolve()); });
  const address = lease.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((resolve) => lease.close(() => resolve()));
  return port;
}

export interface Profile {
  dir: string;
  dataDir: string;
  logFile: string;
  /** Kills everything this test started and removes the profile. Safe to call twice. */
  cleanup(): Promise<void>;
  /** Registers a child process or pid to kill during cleanup. */
  track(child: ChildProcess | number): void;
}

/** A fresh temporary profile. `prefs` pre-writes prefs.json; `setup` can seed the data directory. */
export async function makeProfile(opts: { prefs?: Record<string, unknown>; setup?: (dataDir: string) => Promise<void> | void } = {}): Promise<Profile> {
  const dir = await mkdtemp(join(tmpdir(), 'osb-electron-'));
  const dataDir = join(dir, 'data');
  if (opts.prefs) await writeFile(join(dir, 'prefs.json'), JSON.stringify(opts.prefs));
  if (opts.setup) { await mkdir(dataDir, { recursive: true }); await opts.setup(dataDir); }
  const children: (ChildProcess | number)[] = [];
  const apps: ElectronApplication[] = [];
  let cleaned = false;
  const profile: Profile & { apps: ElectronApplication[] } = {
    dir, dataDir, logFile: join(dir, 'logs', 'Open Smart Buttons.log'), apps,
    track: (c) => { children.push(c); },
    async cleanup() {
      if (cleaned) return;
      cleaned = true;
      for (const app of apps) await closeApp(app);
      // A service the app did not drain (the test killed the app) still holds its pid in server.json.
      const server = readServer(dataDir);
      if (server && alive(server.pid)) kill(server.pid, 'SIGKILL');
      for (const c of children) {
        if (typeof c === 'number') { if (alive(c)) kill(c, 'SIGKILL'); }
        else if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
      }
      // Chromium helpers can still flush Local State for a moment after the app exits; sweep again.
      for (let i = 0; i < 5; i++) {
        await rm(dir, { recursive: true, force: true, maxRetries: 3 });
        await sleep(300);
        if (!existsSync(dir)) break;
      }
      // Repair and Start Fresh leave siblings next to the data directory, all inside `dir`.
    },
  };
  return profile;
}

/** Launches the dev app (`electron .`) on the profile with a simulated Stream Deck +. */
export async function launchApp(profile: Profile, extraArgs: string[] = []): Promise<ElectronApplication> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v;
  const app = await electron.launch({
    executablePath: electronBinary,
    args: ['.', `--osb-profile-dir=${profile.dir}`, '--sim', ...extraArgs],
    cwd: root,
    env,
    timeout: 30_000,
  });
  (profile as Profile & { apps: ElectronApplication[] }).apps.push(app);
  return app;
}

/** Quits the app (draining the service), falling back to SIGKILL after 8 s. */
export async function closeApp(app: ElectronApplication): Promise<void> {
  let proc: ChildProcess;
  try { proc = app.process(); } catch { return; } // already closed: playwright dropped the handle
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => proc.once('exit', () => resolve()));
  await Promise.race([app.close().catch(() => {}), sleep(8000)]);
  if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
  await Promise.race([exited, sleep(2000)]);
}

export function readServer(dataDir: string): { pid: number; port: number } | null {
  try { return JSON.parse(readFileSync(join(dataDir, 'server.json'), 'utf8')) as { pid: number; port: number }; }
  catch { return null; }
}

export function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export function kill(pid: number, signal: NodeJS.Signals): void {
  try { process.kill(pid, signal); } catch { /* already gone */ }
}

export function readLog(profile: Profile): string {
  try { return readFileSync(profile.logFile, 'utf8'); } catch { return ''; }
}

export function lockExists(profile: Profile): boolean {
  return existsSync(join(profile.dataDir, 'server.lock'));
}

/** Waits for a running service (server.json naming a live pid, other than `notPid`). */
export function waitForService(profile: Profile, ms = 20_000, notPid?: number) {
  return waitFor(() => {
    const s = readServer(profile.dataDir);
    return s && s.pid !== notPid && alive(s.pid) ? s : null;
  }, ms, `The service did not start.\n${readLog(profile).slice(-2000)}`);
}

export type ViewName = 'editor' | 'settings' | 'onboarding';

/** True when a page URL belongs to `view`: the service origin (?view=…) or the status page. */
export function isView(url: string, view: ViewName): boolean {
  if (url.startsWith('osb://status/')) return url.includes('status.html') && url.includes(`view=${view}`);
  if (!url.startsWith('http://127.0.0.1:')) return false;
  const params = new URL(url).searchParams;
  return view === 'editor' ? !params.has('view') : params.get('view') === view;
}

/** Finds the window currently showing `view` (editor, status page included). */
export function findPage(app: ElectronApplication, view: ViewName, ms = 20_000): Promise<Page> {
  return waitFor(() => app.windows().find((p) => !p.isClosed() && isView(p.url(), view)), ms, `No ${view} window appeared (have: ${app.windows().map((p) => p.url()).join(', ') || 'none'}).`);
}

/** Opens the editor the way clicking the Dock icon does, and returns its page. */
export async function openEditor(app: ElectronApplication): Promise<Page> {
  await app.evaluate(({ app: a }) => { a.emit('activate'); });
  return findPage(app, 'editor');
}

/** Waits until the page shows the connected editor with the simulated deck's keys. */
export async function waitForEditor(page: Page, ms = 20_000): Promise<void> {
  await waitFor(() => page.url().startsWith('http://127.0.0.1:') && !new URL(page.url()).searchParams.has('view'), ms, `The editor did not load (at ${page.url()}).`);
  await page.locator('#deck-key-0').waitFor({ state: 'visible', timeout: ms });
  await page.locator('.offline').waitFor({ state: 'detached', timeout: ms });
}

/** Number of visible BrowserWindows in the main process. */
export function visibleWindowCount(app: ElectronApplication): Promise<number> {
  return app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => w.isVisible()).length);
}

/** Starts the terminal service (`node src/server/main.ts`) on the profile's data directory. */
export async function startCli(profile: Profile): Promise<{ child: ChildProcess; port: number; stop(): Promise<void> }> {
  const port = await freePort();
  const child = spawn(process.execPath, ['src/server/main.ts', '--no-hid', '--port', String(port), '--data', profile.dataDir], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ANTHROPIC_API_KEY: '' },
  });
  profile.track(child);
  let output = '';
  child.stdout?.on('data', (d: Buffer) => { output += String(d); });
  child.stderr?.on('data', (d: Buffer) => { output += String(d); });
  await waitFor(() => {
    if (child.exitCode !== null) throw new Error(`CLI exited: ${output}`);
    return output.includes('Open the editor at');
  }, 20_000, 'The terminal service did not start.');
  return {
    child, port,
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      child.kill('SIGTERM');
      await Promise.race([exited, sleep(5000)]);
      if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
    },
  };
}
