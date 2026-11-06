// Updates through electron-updater. Manual by default: nothing is fetched unless the user clicks
// Check for Updates or turns on automatic checks. The macOS updater verifies the code signature.

import { app } from 'electron';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { UpdateStatus } from './protocol.ts';
import { log } from './log.ts';

type AutoUpdater = typeof import('electron-updater').autoUpdater;

let updater: AutoUpdater | null = null;
let status: UpdateStatus = { state: 'idle' };
let onChange: (s: UpdateStatus) => void = () => {};
let timer: NodeJS.Timeout | null = null;
const SIX_HOURS = 6 * 60 * 60 * 1000;

function set(next: UpdateStatus) {
  status = next;
  onChange(next);
}

export function updateStatus(): UpdateStatus {
  return status;
}

/** electron-builder writes app-update.yml only when a publish target is configured. */
function configured(): boolean {
  return app.isPackaged && existsSync(join(process.resourcesPath, 'app-update.yml'));
}

export async function initUpdater(listener: (s: UpdateStatus) => void, automatic: boolean): Promise<void> {
  onChange = listener;
  if (!configured()) {
    set({ state: 'unavailable', reason: app.isPackaged ? 'This build has no update channel.' : 'Updates are off in development builds.' });
    return;
  }
  const { autoUpdater } = await import('electron-updater');
  updater = autoUpdater;
  autoUpdater.autoDownload = true;
  // Lets Squirrel stage the update as soon as it downloads, so Restart to Update quits at once.
  // A downloaded update also installs on a normal quit, which is what Mac users expect.
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;
  autoUpdater.logger = { info: (m: unknown) => log('update', String(m)), warn: (m: unknown) => log('update', String(m)), error: (m: unknown) => log('update', String(m)), debug: () => {} };
  autoUpdater.on('checking-for-update', () => set({ state: 'checking' }));
  autoUpdater.on('update-not-available', () => set({ state: 'current', version: app.getVersion() }));
  autoUpdater.on('update-available', (info) => set({ state: 'downloading', percent: 0, version: info.version }));
  autoUpdater.on('download-progress', (p) => {
    if (status.state === 'downloading') set({ ...status, percent: Math.round(p.percent) });
  });
  autoUpdater.on('update-downloaded', (info) => set({ state: 'ready', version: info.version }));
  autoUpdater.on('error', (error) => set({ state: 'error', message: friendly(error) }));
  setAutomatic(automatic);
}

function friendly(error: Error): string {
  const text = error.message || String(error);
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|network/i.test(text)) return 'Couldn’t check for updates. Check your internet connection and try again.';
  if (/signature|code sign/i.test(text)) return 'The update failed its signature check and was not installed.';
  return 'Could not check for updates.';
}

export async function checkForUpdates(): Promise<void> {
  if (!updater) return;
  if (status.state === 'checking' || status.state === 'downloading' || status.state === 'ready') return;
  try { await updater.checkForUpdates(); }
  catch (error) { set({ state: 'error', message: friendly(error as Error) }); }
}

export function setAutomatic(on: boolean): void {
  if (timer) { clearInterval(timer); timer = null; }
  if (!updater || !on) return;
  setTimeout(() => void checkForUpdates(), 30_000);
  timer = setInterval(() => void checkForUpdates(), SIX_HOURS);
}

export function updateReady(): boolean {
  return status.state === 'ready';
}

/**
 * Called after the service has drained. Returns false when there is nothing to install. If the
 * installer does not take over within a minute, the app relaunches so the deck keeps working.
 */
export function installUpdate(): boolean {
  if (!updater) return false;
  const recover = () => { log('update', 'install did not start; relaunching'); app.relaunch(); app.exit(0); };
  const timer = setTimeout(recover, 60_000);
  updater.once('error', () => { clearTimeout(timer); recover(); });
  updater.quitAndInstall(false, true);
  return true;
}
