// StreamDeckPlus desktop app: the main process is a supervisor only. It owns windows, menus, the menu
// bar extra, preferences, the Keychain-held API key and updates. USB, rendering and Mac actions run in
// the service utility process (service-entry.ts).

import { app, BrowserWindow, clipboard, ipcMain, Menu, nativeTheme, Notification, shell, type IpcMainInvokeEvent, type MenuItemConstructorOptions } from 'electron';
import { dirname, join, resolve } from 'node:path';
import { homedir, release } from 'node:os';
import { existsSync, renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ServiceHost } from './service-host.ts';
import { PrefStore } from './prefs.ts';
import { SecretStore } from './secrets.ts';
import { initLog, log, logFile } from './log.ts';
import { buildAppMenu, type RendererCommand } from './menu.ts';
import { primaryDevice, setTrayVisible, updateTray } from './tray.ts';
import { checkElgato, disableLoginItems, elgatoStatus, openAtLoginStatus, quitElgato, setOpenAtLogin, watchPower } from './system.ts';
import { checkForUpdates, initUpdater, installUpdate, setAutomatic, updateReady, updateStatus } from './updater.ts';
import { getWindow, initWindows, isAppUrl, reloadForPhase, sendToAll, showStatusPage, showWindow, visibleWindows, confirmDialog, type View } from './windows.ts';
import type { NativeState, Prefs } from './protocol.ts';
import type { NativeCommand, PrefKey } from '../src/shared/native.ts';

const here = dirname(fileURLToPath(import.meta.url));
const APP_NAME = 'StreamDeckPlus';
app.setName(APP_NAME);

// ---- Launch options ------------------------------------------------------------------------------
// --sdp-profile-dir=DIR isolates preferences, the key, logs and data (tests, smoke checks).
// --sim runs with a simulated Stream Deck + and no USB. --smoke runs the packaged self-check and exits.
const argv = process.argv.slice(1);
const argValue = (name: string) => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const profileDir = argValue('sdp-profile-dir');
const simMode = argv.includes('--sim');
const smoke = argv.includes('--smoke');
if (profileDir) { app.setPath('userData', resolve(profileDir)); disableLoginItems(); }
const dataDir = profileDir ? join(resolve(profileDir), 'data')
  : process.env.STREAMDECKPLUS_DATA ? resolve(process.env.STREAMDECKPLUS_DATA) : join(homedir(), '.streamdeckplus');
initLog(profileDir ? join(resolve(profileDir), 'logs') : app.getPath('logs'));
delete process.env.ANTHROPIC_API_KEY; // never inherited by anything this app starts

if (!smoke && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  void main();
}

async function main() {
  const prefs = new PrefStore(app.getPath('userData'));
  const secrets = new SecretStore(app.getPath('userData'));
  const inference = () => ({ apiKey: secrets.get(), model: prefs.value.model, preference: prefs.value.aiProvider });
  const host = new ServiceHost({
    entry: join(here, 'service-entry.ts'),
    dataDir,
    appName: APP_NAME,
    sim: simMode,
    savedPort: prefs.value.port,
    savePort: (port) => prefs.set('port', port),
    inference,
  });
  let quitting = false;
  let drained = false;
  let installAfterQuit = false;

  process.on('SIGTERM', () => app.quit());
  process.on('SIGINT', () => app.quit());

  app.on('before-quit', (event) => {
    quitting = true;
    if (drained) return;
    event.preventDefault();
    if (host.isStopping) return;
    log('main', 'quitting: stopping the service');
    void host.stop().then(() => {
      drained = true;
      log('main', 'service stopped');
      if (!installAfterQuit || !installUpdate()) app.quit();
    });
  });

  await app.whenReady();
  log('main', `StreamDeckPlus ${app.getVersion()} starting (packaged: ${app.isPackaged}, macOS ${process.getSystemVersion?.() ?? release()}, ${process.arch})`);

  if (smoke) { await runSmoke(host); return; }

  nativeTheme.themeSource = prefs.value.theme;
  const showInMenuBar = () => prefs.value.showInMenuBar;

  // ---- Windows and dock policy -----------------------------------------------------------------
  const syncDock = () => {
    if (!app.dock) return;
    if (visibleWindows().length > 0 || !showInMenuBar()) void app.dock.show();
    else app.dock.hide();
  };
  initWindows({
    here,
    origin: () => host.phase.phase === 'ready' ? host.origin : null,
    url: () => host.phase.phase === 'ready' ? host.url : null,
    bounds: () => prefs.value.windowBounds,
    saveBounds: (b) => prefs.set('windowBounds', b),
    onWindowsChanged: () => { syncDock(); refreshMenus(); },
    onEditorClose: (event) => {
      if (quitting) return;
      // Closing the editor hides it: StreamDeckPlus keeps running the deck.
      event.preventDefault();
      getWindow('editor')?.hide();
      if (showInMenuBar() && !prefs.value.closeNoticeShown) {
        prefs.set('closeNoticeShown', true);
        if (Notification.isSupported()) new Notification({ title: APP_NAME, body: 'StreamDeckPlus is still running in the menu bar.', silent: true }).show();
      }
    },
  });

  // ---- Native state shared with every window ---------------------------------------------------
  const snapshot = (): NativeState => ({
    version: app.getVersion(),
    packaged: app.isPackaged,
    service: host.phase,
    prefs: {
      onboarded: prefs.value.onboarded,
      // Before onboarding nothing is registered yet, so show the default choice, not the live state.
      openAtLogin: prefs.value.onboarded ? (openAtLoginStatus() ?? prefs.value.openAtLogin) : prefs.value.openAtLogin,
      showInMenuBar: prefs.value.showInMenuBar,
      checkForUpdates: prefs.value.checkForUpdates,
      model: prefs.value.model,
      aiProvider: prefs.value.aiProvider,
      theme: prefs.value.theme,
    },
    ai: { hasKey: secrets.has(), model: prefs.value.model, provider: prefs.value.aiProvider, secureStorage: secrets.available() },
    update: updateStatus(),
    elgato: elgatoStatus(),
    dataDir,
  });
  const broadcast = () => sendToAll('sdp:native-state', snapshot());

  // ---- Menu bar extra and app menu -------------------------------------------------------------
  const rpc = (method: string, params: Record<string, unknown> = {}) => host.rpc(method, params).catch((error: Error) => {
    log('main', `${method}: ${error.message}`);
    return undefined;
  });
  // Clicks the editor's file input with a user gesture, waiting (up to 10 s) for the editor to mount.
  const clickImport = async (wc: Electron.WebContents) => {
    for (let i = 0; i < 50 && !wc.isDestroyed(); i++) {
      const clicked = await wc.executeJavaScript(
        "(() => { const el = document.getElementById('profile-import'); if (el) { el.click(); return true; } return false; })()", true,
      ).catch(() => false);
      if (clicked) return;
      await new Promise((r) => setTimeout(r, 200));
    }
  };
  const toRenderer = (command: RendererCommand) => {
    const wc = getWindow('editor')?.webContents;
    if (!wc) return;
    const deliver = () => {
      // A file picker needs a user gesture in the page; a menu click is not one, so grant it here.
      if (command === 'profile.import') void clickImport(wc);
      else wc.send('sdp:menu', command);
    };
    if (wc.isLoading()) wc.once('did-finish-load', deliver); else deliver();
  };

  function trayMenu(): MenuItemConstructorOptions[] {
    const state = host.appState;
    const ready = host.phase.phase === 'ready';
    const device = primaryDevice(state);
    const items: MenuItemConstructorOptions[] = [];
    const headline = !ready ? (host.phase.phase === 'fatal' || host.phase.phase === 'error' ? 'StreamDeckPlus needs attention' : 'Starting…')
      : state?.platform.hidError ? "Device support didn't load"
      : device ? `${device.modelName} — Connected` : 'No deck connected';
    items.push({ label: headline, enabled: false });
    if (ready && device && state) {
      const profiles = state.config.profiles.filter((p) => p.modelId === device.modelId);
      items.push({
        label: 'Profile',
        submenu: profiles.map((p) => ({
          label: p.name, type: 'radio' as const, checked: p.id === device.profileId,
          click: () => void rpc('session.setProfile', { deviceId: device.id, profileId: p.id }),
        })),
      });
      items.push({
        label: 'Brightness',
        submenu: [25, 50, 75, 100].map((value) => ({
          label: `${value}%`, type: 'radio' as const, checked: Math.abs(device.brightness - value) < 13,
          click: () => void rpc('devices.setBrightness', { deviceId: device.id, value }),
        })),
      });
    }
    items.push({ type: 'separator' });
    items.push({ label: 'Open StreamDeckPlus', click: () => showWindow('editor') });
    if (ready && state) {
      items.push({
        label: 'Pause Mac Actions', type: 'checkbox', checked: !state.config.settings.executeActions,
        click: () => void rpc('settings.update', { patch: { executeActions: !state.config.settings.executeActions } }),
      });
    }
    const attention: MenuItemConstructorOptions[] = [];
    if (ready && state?.platform.permissions.some((p) => p.ok === false) && state.config.settings.executeActions) {
      attention.push({ label: '⚠ Allow StreamDeckPlus to press keys…', click: () => openSettings('permissions') });
    }
    const elgato = elgatoStatus();
    if (elgato.running && !device) {
      attention.push({ label: `⚠ ${elgato.name} is using your deck — Quit It and Connect`, click: () => void quitElgato().then(pollElgato) });
    }
    if (updateReady()) attention.push({ label: '⚠ Restart to Update', click: () => restartToUpdate() });
    if (host.phase.phase === 'fatal' || host.phase.phase === 'error') attention.push({ label: '⚠ Show What Happened', click: () => showWindow('editor') });
    if (attention.length) items.push({ type: 'separator' }, ...attention);
    items.push(
      { type: 'separator' },
      { label: 'Settings…', accelerator: 'Command+,', click: () => openSettings() },
      { label: 'Check for Updates…', enabled: updateStatus().state !== 'unavailable', click: () => checkAndShow() },
      { label: 'Quit StreamDeckPlus', accelerator: 'Command+Q', click: () => app.quit() },
    );
    return items;
  }

  function needsUser(): boolean {
    const state = host.appState;
    if (host.phase.phase === 'fatal' || host.phase.phase === 'error') return true;
    if (state?.platform.hidError || updateReady()) return true;
    if (elgatoStatus().running && !primaryDevice(state)) return true;
    return !!state?.config.settings.executeActions && !!state.platform.permissions.some((p) => p.ok === false);
  }

  let menuTimer: NodeJS.Timeout | null = null;
  function refreshMenus() {
    if (menuTimer) return;
    menuTimer = setTimeout(() => {
      menuTimer = null;
      setTrayVisible(showInMenuBar());
      updateTray(primaryDevice(host.appState) ? 'solid' : 'outline', needsUser(), trayMenu());
      buildAppMenu({
        toRenderer,
        openSettings: () => openSettings(),
        openEditor: () => showWindow('editor'),
        rescan: () => void rpc('devices.scan'),
        addSimulator: (model) => void rpc('sim.add', { modelId: model }),
        checkForUpdates: () => checkAndShow(),
        copyDiagnostics: () => { clipboard.writeText(diagnostics()); },
        showLogs: () => { shell.showItemInFolder(logFile()); },
        editorReady: () => host.phase.phase === 'ready',
      });
    }, 50);
  }

  function openSettings(tab?: string) {
    const win = showWindow('settings');
    if (tab) {
      const send = () => win.webContents.send('sdp:menu', `settings.${tab}`);
      if (win.webContents.isLoading()) win.webContents.once('did-finish-load', send); else send();
    }
  }

  function checkAndShow() {
    openSettings('updates');
    void checkForUpdates();
  }

  function restartToUpdate() {
    installAfterQuit = true;
    app.quit();
  }

  function diagnostics(): string {
    const s = host.appState;
    const lines = [
      `StreamDeckPlus ${app.getVersion()} (${app.isPackaged ? 'app' : 'development'})`,
      `macOS ${process.getSystemVersion?.() ?? release()} on ${process.arch}; Electron ${process.versions.electron}`,
      `Service: ${host.phase.phase}`,
      `USB support: ${s ? (s.platform.hidAvailable ? 'loaded' : s.platform.hidError ? `failed (${s.platform.hidError})` : 'off') : 'unknown'}`,
      `Mac actions: ${s ? (s.config.settings.executeActions ? 'on' : 'paused') : 'unknown'}`,
      ...(s?.platform.permissions ?? []).map((p) => `${p.label}: ${p.ok === null ? 'unknown' : p.ok ? 'allowed' : 'not allowed'}`),
      ...(s?.devices ?? []).map((d) => `Deck: ${d.modelName} (${d.kind === 'sim' ? 'simulator' : `firmware ${d.firmware}`})`),
      `Conflicting app: ${elgatoStatus().running ? elgatoStatus().name : 'none'}`,
    ];
    return lines.join('\n');
  }

  // ---- Elgato conflict polling (only while no physical deck is connected) ----------------------
  let elgatoTimer: NodeJS.Timeout | null = null;
  async function pollElgato() {
    if (elgatoTimer) clearTimeout(elgatoTimer);
    const before = JSON.stringify(elgatoStatus());
    if (host.phase.phase === 'ready' && !primaryDevice(host.appState)) await checkElgato();
    else if (elgatoStatus().running) await checkElgato();
    if (JSON.stringify(elgatoStatus()) !== before) { broadcast(); refreshMenus(); }
    elgatoTimer = setTimeout(() => void pollElgato(), 4000);
  }

  // ---- Service events ---------------------------------------------------------------------------
  host.on('phase', (phase) => {
    log('main', `service phase: ${phase.phase}`);
    if (phase.phase === 'ready') reloadForPhase(true);
    if (phase.phase === 'fatal' || phase.phase === 'error') {
      showStatusPage();
      if (!quitting) showWindow('editor');
    }
    broadcast();
    refreshMenus();
  });
  host.on('appState', () => refreshMenus());

  watchPower(() => void rpc('devices.refresh'));

  // ---- IPC: the renderer's only door into the main process -------------------------------------
  const PREF_KEYS: readonly PrefKey[] = ['openAtLogin', 'showInMenuBar', 'checkForUpdates', 'theme', 'model', 'aiProvider'];
  const guard = (event: IpcMainInvokeEvent) => {
    if (!isAppUrl(event.senderFrame?.url)) throw new Error('Not allowed from this page.');
  };

  function applyPref(key: PrefKey, value: unknown) {
    switch (key) {
      case 'openAtLogin': case 'showInMenuBar': case 'checkForUpdates':
        if (typeof value !== 'boolean') throw new Error('Expected on or off.');
        prefs.set(key, value);
        if (key === 'openAtLogin') setOpenAtLogin(value);
        if (key === 'checkForUpdates') setAutomatic(value);
        if (key === 'showInMenuBar') syncDock();
        break;
      case 'theme':
        if (value !== 'system' && value !== 'light' && value !== 'dark') throw new Error('Unknown theme.');
        prefs.set('theme', value);
        nativeTheme.themeSource = value;
        break;
      case 'model': {
        const model = typeof value === 'string' ? value.trim() : '';
        if (!/^[A-Za-z0-9._:@-]{1,100}$/.test(model)) throw new Error('Enter a model name such as claude-sonnet-5-5.');
        prefs.set('model', model);
        host.setInference(inference());
        break;
      }
      case 'aiProvider':
        if (value !== 'auto' && value !== 'claude' && value !== 'codex' && value !== 'api') throw new Error('Unknown AI engine.');
        prefs.set('aiProvider', value);
        host.setInference(inference());
        break;
    }
    broadcast();
    refreshMenus();
  }

  const commands: Record<NativeCommand, (arg: unknown, event: IpcMainInvokeEvent) => unknown> = {
    'service.restart': () => host.restart(),
    'service.repair': async () => {
      const ok = await confirmDialog('Repair your settings?', 'StreamDeckPlus writes a repaired copy and keeps the original folder next to it.', 'Repair');
      return ok ? host.repair() : { ok: false, message: '' };
    },
    'service.startFresh': async () => {
      if (host.phase.phase !== 'error' || host.phase.kind !== 'config-invalid') return { ok: false, message: 'Nothing to reset.' };
      const ok = await confirmDialog('Start with fresh settings?', 'Your current folder is renamed and kept, never deleted.', 'Start Fresh');
      if (!ok) return { ok: false, message: '' };
      const aside = `${dataDir}-unreadable-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      if (existsSync(aside)) return { ok: false, message: 'Try again in a moment.' };
      renameSync(dataDir, aside);
      log('main', `moved unreadable data aside to ${aside}`);
      host.restart();
      return { ok: true, message: `Your old settings are kept at ${aside}.` };
    },
    'logs.show': () => shell.showItemInFolder(logFile()),
    'data.show': () => { void shell.openPath(existsSync(dataDir) ? dataDir : dirname(dataDir)); },
    'elgato.quit': async () => { const ok = await quitElgato(); await pollElgato(); return ok; },
    'settings.open': (tab) => openSettings(typeof tab === 'string' && /^[a-z]+$/.test(tab) ? tab : undefined),
    'editor.open': () => showWindow('editor'),
    'permissions.open': (kind) => {
      const pane = kind === 'automation' ? 'Privacy_Automation' : 'Privacy_Accessibility';
      void shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${pane}`);
    },
    'update.check': () => checkForUpdates(),
    'update.install': () => restartToUpdate(),
    'ai.test': () => host.testInference(),
    'diagnostics.copy': () => { clipboard.writeText(diagnostics()); return true; },
    'onboarding.finish': (arg) => {
      const choice = (arg ?? {}) as { openAtLogin?: unknown; showInMenuBar?: unknown };
      if (typeof choice.openAtLogin === 'boolean') applyPref('openAtLogin', choice.openAtLogin);
      if (typeof choice.showInMenuBar === 'boolean') applyPref('showInMenuBar', choice.showInMenuBar);
      prefs.set('onboarded', true);
      getWindow('onboarding')?.close();
      showWindow('editor');
      broadcast();
    },
    'licenses.show': () => {
      void shell.openPath(join(app.isPackaged ? process.resourcesPath : app.getAppPath(), 'THIRD_PARTY_NOTICES.md'));
    },
  };

  ipcMain.handle('sdp:state', (event) => { guard(event); return snapshot(); });
  ipcMain.handle('sdp:command', (event, name: unknown, arg: unknown) => {
    guard(event);
    const fn = typeof name === 'string' && Object.hasOwn(commands, name) ? commands[name as NativeCommand] : undefined;
    if (!fn) throw new Error('Unknown command.');
    return fn(arg, event);
  });
  ipcMain.handle('sdp:set-pref', (event, key: unknown, value: unknown) => {
    guard(event);
    if (typeof key !== 'string' || !(PREF_KEYS as readonly string[]).includes(key)) throw new Error('Unknown setting.');
    applyPref(key as PrefKey, value);
    return snapshot();
  });
  ipcMain.handle('sdp:set-api-key', (event, key: unknown) => {
    guard(event);
    if (key !== null && typeof key !== 'string') throw new Error('Expected a key.');
    secrets.set(key);
    host.setInference(inference());
    broadcast();
    return snapshot();
  });
  ipcMain.handle('sdp:context-menu', (event, items: unknown) => {
    guard(event);
    if (!Array.isArray(items) || items.length > 20) throw new Error('Bad menu.');
    const win = BrowserWindow.fromWebContents(event.sender);
    return new Promise<string | null>((done) => {
      let chosen: string | null = null;
      const template: MenuItemConstructorOptions[] = items.map((raw) => {
        const item = (raw ?? {}) as { id?: unknown; label?: unknown; enabled?: unknown; separator?: unknown };
        if (item.separator === true) return { type: 'separator' as const };
        const id = String(item.id ?? '').slice(0, 40);
        return { label: String(item.label ?? '').slice(0, 80), enabled: item.enabled !== false, click: () => { chosen = id; } };
      });
      Menu.buildFromTemplate(template).popup({ window: win ?? undefined, callback: () => setImmediate(() => done(chosen)) });
    });
  });

  // ---- Go ---------------------------------------------------------------------------------------
  refreshMenus();
  syncDock();
  await host.start();
  void pollElgato();
  void initUpdater(() => { broadcast(); refreshMenus(); }, prefs.value.checkForUpdates);
  if (!prefs.value.onboarded) {
    // First run: the login item is registered when onboarding finishes, with the user's choice.
    showWindow('onboarding');
  } else if (!showInMenuBar()) {
    showWindow('editor'); // no menu bar extra: the window is the way in
  }

  app.on('activate', () => showWindow(prefs.value.onboarded ? 'editor' : 'onboarding'));
  app.on('second-instance', () => showWindow(prefs.value.onboarded ? 'editor' : 'onboarding'));
  app.on('window-all-closed', () => { /* keep running: the deck still works */ });
}

/** Packaged self-check: USB support loads, a key renders, and the editor serves. */
async function runSmoke(host: ServiceHost) {
  const result: Record<string, unknown> = { version: app.getVersion(), arch: process.arch };
  let finished = false;
  const done = (ok: boolean) => {
    if (finished) return;
    finished = true;
    result.ok = ok;
    process.stdout.write(`SMOKE ${JSON.stringify(result)}\n`);
    void host.stop().then(() => app.exit(ok ? 0 : 1));
  };
  const timeout = setTimeout(() => { result.error = 'timed out'; done(false); }, 30_000);
  host.on('phase', async (phase) => {
    if (phase.phase === 'error' || phase.phase === 'fatal') { clearTimeout(timeout); result.error = phase; done(false); return; }
    if (phase.phase !== 'ready') return;
    try {
      const page = await fetch(`${host.origin}/`);
      result.editor = page.status;
      const state = await (await fetch(`${host.origin}/api/state`, { headers: { authorization: `Bearer ${host.token}` } })).json() as { platform: { hidAvailable: boolean; hidError?: string } };
      result.hidAvailable = state.platform.hidAvailable;
      result.hidError = state.platform.hidError ?? null;
      // One simulated Neo proves the canvas renderer works: it paints every key on attach.
      if (!await host.whenSocketOpen(10_000)) throw new Error('the menu connection did not open');
      const seen = new Set<string>();
      let wake: () => void = () => {};
      host.on('frame', (deviceId) => { seen.add(deviceId); wake(); });
      const simId = await host.rpc<string>('sim.add', { modelId: 'neo' });
      const rendered = seen.has(simId) || await new Promise<boolean>((ok) => {
        const t = setTimeout(() => ok(false), 8000);
        wake = () => { if (seen.has(simId)) { clearTimeout(t); ok(true); } };
      });
      result.render = rendered;
      clearTimeout(timeout);
      done(page.status === 200 && state.platform.hidAvailable && result.render === true);
    } catch (error) {
      clearTimeout(timeout);
      result.error = (error as Error).message;
      done(false);
    }
  });
  await host.start();
}

export type { View, Prefs };
