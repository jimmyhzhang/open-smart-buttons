// macOS integration that needs no special permission: the Elgato app conflict, sleep/wake and the
// login item. Uses lsappinfo (LaunchServices), never AppleScript.

import { app, powerMonitor } from 'electron';
import { execFile } from 'node:child_process';
import type { ElgatoStatus } from './protocol.ts';
import { log } from './log.ts';

/** Apps that open Stream Deck hardware exclusively. */
// lsappinfo accepts a bundle ID or an app name.
const CONFLICTING = [
  { bundle: 'com.elgato.StreamDeck', name: 'Elgato Stream Deck' },
  { bundle: 'OpenDeck', name: 'OpenDeck' },
];

function lsappinfo(args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile('/usr/bin/lsappinfo', args, { timeout: 3000 }, (error, stdout) => resolve(error ? '' : String(stdout)));
  });
}

async function findConflict(): Promise<{ pid: number; name: string } | null> {
  for (const c of CONFLICTING) {
    const out = await lsappinfo(['info', '-only', 'pid', '-app', c.bundle]);
    const pid = Number(/\bpid\s*=\s*(\d+)/i.exec(out)?.[1]);
    if (Number.isInteger(pid) && pid > 1) return { pid, name: c.name };
  }
  return null;
}

let status: ElgatoStatus = { running: false };
let quitAt = 0;

export async function checkElgato(): Promise<ElgatoStatus> {
  const found = await findConflict();
  const reopened = !!found && quitAt > 0 && Date.now() - quitAt > 5000 && Date.now() - quitAt < 120_000;
  status = found ? { running: true, name: found.name, reopened } : { running: false };
  return status;
}

export function elgatoStatus(): ElgatoStatus {
  return status;
}

/** SIGTERM to the app that holds the deck. The device manager's retry then connects. */
export async function quitElgato(): Promise<boolean> {
  const found = await findConflict();
  if (!found) return false;
  try {
    process.kill(found.pid, 'SIGTERM');
    quitAt = Date.now();
    log('main', `asked ${found.name} (pid ${found.pid}) to quit`);
    return true;
  } catch (error) {
    log('main', `could not quit ${found.name}: ${(error as Error).message}`);
    return false;
  }
}

/** Wake and unlock: repaint the deck, which may have lost its images while the Mac slept. */
export function watchPower(refresh: () => void): void {
  let timer: NodeJS.Timeout | null = null;
  const soon = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(refresh, 1500);
  };
  powerMonitor.on('resume', soon);
  powerMonitor.on('unlock-screen', soon);
}

let loginItemsAllowed = true;
/** Isolated profiles (tests, smoke checks) never touch the user's login items. */
export function disableLoginItems(): void {
  loginItemsAllowed = false;
}

export function setOpenAtLogin(on: boolean): void {
  if (!app.isPackaged || !loginItemsAllowed) return; // a dev Electron binary must never register itself
  try { app.setLoginItemSettings({ openAtLogin: on }); }
  catch (error) { log('main', `login item: ${(error as Error).message}`); }
}

export function openAtLoginStatus(): boolean | null {
  if (!app.isPackaged || !loginItemsAllowed) return null;
  try { return app.getLoginItemSettings().openAtLogin; } catch { return null; }
}
