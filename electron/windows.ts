// App windows: the editor, Settings and onboarding. Every window loads the service origin (or the local
// status page while the service is unavailable) and is locked to it.

import { app, BrowserWindow, dialog, nativeTheme, screen, session, type WebContents } from 'electron';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { log } from './log.ts';
import { installStatusProtocol, isStatusUrl, statusUrl } from './status-protocol.ts';

export type View = 'editor' | 'settings' | 'onboarding';

export interface WindowContext {
  here: string;
  /** Service origin while it is ready, else null. */
  origin(): string | null;
  /** Editor URL with the credential fragment while ready, else null. */
  url(): string | null;
  bounds(): { x: number; y: number; width: number; height: number } | undefined;
  saveBounds(bounds: { x: number; y: number; width: number; height: number }): void;
  onWindowsChanged(): void;
  onEditorClose(event: Electron.Event): void;
}

const windows = new Map<View, BrowserWindow>();
/** Windows whose last main-frame load failed: Chromium shows an error page at the editor URL. */
const failedLoad = new WeakSet<BrowserWindow>();
let ctx: WindowContext;

export function initWindows(context: WindowContext): void {
  ctx = context;
  installStatusProtocol(context.here);
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, permission, callback, details) => {
    callback(permission === 'clipboard-sanitized-write' && isAppUrl(details.requestingUrl));
  });
  ses.setPermissionCheckHandler((_wc, permission, origin) => permission === 'clipboard-sanitized-write' && isAppUrl(origin));
  ses.on('will-download', (event, item) => {
    const url = item.getURL();
    const origin = ctx.origin();
    if (!origin || !url.startsWith(`blob:${origin}/`)) {
      log('main', 'blocked a download that was not created by the editor');
      event.preventDefault();
      return;
    }
    item.setSaveDialogOptions({ defaultPath: join(homedir(), 'Downloads', item.getFilename()) });
  });
}

/** True for the service origin and the bundled status page. */
export function isAppUrl(url: string | undefined | null): boolean {
  if (!url) return false;
  const origin = ctx.origin();
  if (origin && (url === origin || url.startsWith(`${origin}/`))) return true;
  return isStatusUrl(url);
}

function lockdown(wc: WebContents) {
  wc.on('will-navigate', (event, url) => {
    log('main', `blocked navigation to ${safeUrl(url)}`);
    event.preventDefault();
  });
  wc.on('will-redirect', (event, url) => {
    log('main', `blocked redirect to ${safeUrl(url)}`);
    event.preventDefault();
  });
  wc.on('will-frame-navigate', (event) => {
    if (!event.isMainFrame) event.preventDefault();
  });
  wc.setWindowOpenHandler(({ url }) => {
    log('main', `blocked a new window for ${safeUrl(url)}`);
    return { action: 'deny' };
  });
  wc.on('will-attach-webview', (event) => event.preventDefault());
}

function safeUrl(url: string): string {
  try { const u = new URL(url); return `${u.protocol}//${u.host}${u.pathname}`; } catch { return '(invalid url)'; }
}

const SIZES: Record<View, { width: number; height: number; minWidth: number; minHeight: number; resizable: boolean }> = {
  editor: { width: 1280, height: 820, minWidth: 960, minHeight: 620, resizable: true },
  settings: { width: 640, height: 560, minWidth: 640, minHeight: 480, resizable: true },
  onboarding: { width: 520, height: 560, minWidth: 520, minHeight: 560, resizable: false },
};

function backgroundColor() {
  return nativeTheme.shouldUseDarkColors ? '#181b1e' : '#e3e6e9';
}

function boundsOnScreen(b: { x: number; y: number; width: number; height: number } | undefined) {
  if (!b) return undefined;
  const visible = screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return b.x < a.x + a.width - 80 && b.x + b.width > a.x + 80 && b.y >= a.y - 10 && b.y < a.y + a.height - 80;
  });
  return visible ? b : undefined;
}

export function getWindow(view: View): BrowserWindow | undefined {
  const win = windows.get(view);
  return win && !win.isDestroyed() ? win : undefined;
}

export function visibleWindows(): BrowserWindow[] {
  return [...windows.values()].filter((w) => !w.isDestroyed() && w.isVisible());
}

/** Shows (creating if needed) a window and loads the right page for the current service phase. */
export function showWindow(view: View): BrowserWindow {
  let win = getWindow(view);
  if (!win) {
    const size = SIZES[view];
    const saved = view === 'editor' ? boundsOnScreen(ctx.bounds()) : undefined;
    win = new BrowserWindow({
      ...size,
      ...(saved ?? {}),
      show: false,
      title: view === 'settings' ? 'Settings' : view === 'onboarding' ? 'Welcome to Open Smart Buttons' : 'Open Smart Buttons',
      titleBarStyle: view === 'editor' ? 'hiddenInset' : 'default',
      trafficLightPosition: view === 'editor' ? { x: 18, y: 20 } : undefined,
      fullscreenable: view === 'editor',
      maximizable: view !== 'onboarding',
      minimizable: true,
      backgroundColor: backgroundColor(),
      webPreferences: {
        preload: join(ctx.here, 'preload.cjs'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        spellcheck: false,
        devTools: !app.isPackaged,
      },
    });
    windows.set(view, win);
    lockdown(win.webContents);
    const created = win;
    created.once('ready-to-show', () => { if (!created.isDestroyed()) created.show(); });
    created.on('show', () => ctx.onWindowsChanged());
    created.on('hide', () => ctx.onWindowsChanged());
    created.on('closed', () => { windows.delete(view); ctx.onWindowsChanged(); });
    if (view === 'editor') {
      const persist = () => { if (!created.isDestroyed() && !created.isMinimized() && !created.isFullScreen()) ctx.saveBounds(created.getNormalBounds()); };
      created.on('resized', persist);
      created.on('moved', persist);
      created.on('close', (event) => ctx.onEditorClose(event));
    }
    created.webContents.on('render-process-gone', (_e, details) => {
      log('main', `renderer for ${view} exited: ${details.reason}`);
      if (details.reason !== 'clean-exit' && !created.isDestroyed()) load(view, created);
    });
    created.webContents.on('did-finish-load', () => failedLoad.delete(created));
    created.webContents.on('did-fail-load', (_e, code, description, _url, isMainFrame) => {
      if (!isMainFrame || code === -3) return; // -3: aborted by a newer load
      failedLoad.add(created);
      log('main', `${view} failed to load: ${description}`);
      setTimeout(() => { if (!created.isDestroyed()) load(view, created); }, 1000);
    });
    load(view, created);
  } else {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
  return win;
}

function targetFor(view: View): string {
  const url = ctx.url();
  if (!url) return statusUrl(view);
  if (view === 'editor') return url;
  const [base, fragment] = url.split('#');
  return `${base}?view=${view}#${fragment}`;
}

function load(view: View, win: BrowserWindow) {
  const target = targetFor(view);
  const origin = ctx.origin();
  const current = win.webContents.getURL();
  // Healthy editor pages reconnect themselves; a recovery page needs no duplicate load.
  if (!failedLoad.has(win) && !win.webContents.isCrashed() &&
    ((origin && current.startsWith(`${origin}/`)) || current === target)) return;
  void win.loadURL(target).catch(() => { /* did-fail-load retries */ });
}

/** Called when the service phase changes: move windows between the editor and the status page. */
export function reloadForPhase(ready: boolean): void {
  for (const [view, win] of windows) {
    if (win.isDestroyed()) continue;
    const current = win.webContents.getURL();
    // load() keeps a healthy page on the current origin; anything else (status page, error page, an
    // origin left behind by a port move) gets the editor URL with the current credential.
    if (ready) load(view, win);
    if (!ready && !isStatusUrl(current) && !current.startsWith('http')) load(view, win);
  }
}

/** Fatal and error states replace the editor with the status page (the editor cannot work). */
export function showStatusPage(): void {
  for (const [view, win] of windows) {
    if (win.isDestroyed() || isStatusUrl(win.webContents.getURL())) continue;
    void win.loadURL(statusUrl(view)).catch(() => {});
  }
}

export function closeWindow(view: View): void {
  getWindow(view)?.close();
}

export function sendToAll(channel: string, payload: unknown): void {
  for (const win of windows.values()) if (!win.isDestroyed()) win.webContents.send(channel, payload);
}

export async function confirmDialog(message: string, detail: string, confirm: string): Promise<boolean> {
  const parent = BrowserWindow.getFocusedWindow() ?? undefined;
  const options = { type: 'question' as const, message, detail, buttons: [confirm, 'Cancel'], defaultId: 0, cancelId: 1 };
  const result = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
  return result.response === 0;
}
