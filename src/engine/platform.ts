// OS integration for built-in actions. macOS uses `open`, AppleScript and JXA (no native addon).
// Other platforms get best-effort equivalents; with executeActions=false everything is logged only.

import { execFile, spawn } from 'node:child_process';
import { platform as osPlatform } from 'node:os';
import type { Hotkey } from '../shared/types.ts';
import type { StateSourceId, StateValue } from '../shared/state-rules.ts';
import { runScript as executeScript, type ScriptCommandOptions } from './script-commands.ts';
import { prepareAgentLaunch, TERMINAL_LAUNCH_SCRIPT, type AgentLaunchOptions } from './agent-launcher.ts';

export type MediaCmd = 'playpause' | 'next' | 'previous' | 'mute' | 'volup' | 'voldown';

export interface PermissionCheck {
  id: 'accessibility' | 'automation';
  ok: boolean | null;
  label: string;
  detail: string;
}

/** Raised when macOS blocks an action because the host app (Terminal, iTerm…) lacks a privacy permission. */
export class PermissionError extends Error {
  readonly permission: 'accessibility' | 'automation';
  constructor(permission: 'accessibility' | 'automation', message: string) {
    super(message);
    this.permission = permission;
  }
}

let appNameOverride: string | null = null;
/** Set by the desktop app: macOS attributes permissions to its bundle, not to a terminal. */
export function setHostAppName(name: string | null): void {
  appNameOverride = name?.trim() || null;
}

/** The app macOS attributes our events to (permissions belong to it, not to node). */
export function hostAppName(): string {
  if (appNameOverride) return appNameOverride;
  const t = process.env.TERM_PROGRAM ?? '';
  const map: Record<string, string> = {
    Apple_Terminal: 'Terminal', 'iTerm.app': 'iTerm', vscode: 'Visual Studio Code', ghostty: 'Ghostty', WarpTerminal: 'Warp',
  };
  return map[t] ?? (t || 'the app that started StreamDeckPlus');
}

export interface Platform {
  readonly os: string;
  readonly canExecute: boolean;
  /** Check (and with prompt=true, request) the OS permissions actions depend on. */
  checkPermissions(prompt?: boolean, probeAutomation?: boolean): Promise<PermissionCheck[]>;
  openPermissionSettings(id: 'accessibility' | 'automation'): Promise<void>;
  openUrl(url: string): Promise<void>;
  openPath(path: string): Promise<void>;
  launchAgent(options: AgentLaunchOptions): Promise<void>;
  hotkey(h: Hotkey): Promise<void>;
  typeText(text: string, opts: { enter?: boolean; paste?: boolean }): Promise<void>;
  media(cmd: MediaCmd): Promise<void>;
  getVolume(): Promise<{ volume: number; muted: boolean }>;
  setVolume(v: number): Promise<void>;
  setMuted(m: boolean): Promise<void>;
  scroll(dx: number, dy: number): Promise<void>;
  run(command: string, timeoutMs?: number): Promise<{ code: number; stdout: string; stderr: string }>;
  runScript(options: ScriptCommandOptions): Promise<{ code: number; stdout: string; stderr: string }>;
  runShortcut(name: string): Promise<void>;
  /** Built-in macOS controls (appearance, lock, display sleep, Mission Control…). */
  macControl(op: MacControlOp): Promise<void>;
  /** Keep the Mac awake (true) or let it sleep normally (false). Returns the resulting state. */
  keepAwake(on: boolean): Promise<boolean>;
  /** Whether Keep Awake is currently on (shared by every Keep Awake button). */
  isAwake(): boolean;
  /** Plain-text clipboard contents (used by the {clipboard} snippet token). */
  readClipboard?(): Promise<string>;
  /** Read one piece of computer state for state rules. Read-only; rejects when it can't be known. */
  readState(source: StateSourceId, arg?: string): Promise<StateValue>;
}

export type CommandRunner = (cmd: string, args: string[], timeout?: number, input?: string) => Promise<{ code: number; stdout: string; stderr: string }>;

export function exec(cmd: string, args: string[], timeout = 10000, input?: string): ReturnType<CommandRunner> {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, { timeout, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as NodeJS.ErrnoException).code === 'number' ? Number((err as NodeJS.ErrnoException).code) : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr || (err ? err.message : '')) });
    });
    // Use stdin for clipboard text, never shell interpolation or command-line arguments.
    child.stdin?.on('error', () => {}); // exit status reports an early pipe close
    child.stdin?.end(input);
  });
}

async function mustExec(cmd: string, args: string[], runner: CommandRunner = exec, input?: string, timeout?: number): Promise<string> {
  const r = await runner(cmd, args, timeout, input);
  if (r.code !== 0) {
    const err = r.stderr.trim();
    // Map macOS privacy errors to something actionable.
    if (/-1743|Not authori[sz]ed to send Apple events/i.test(err)) {
      throw new PermissionError('automation', `macOS blocked this: allow ${hostAppName()} to control System Events (Privacy & Security → Automation).`);
    }
    if (/1002|not allowed to send keystrokes|-25211|assistive access/i.test(err)) {
      throw new PermissionError('accessibility', `macOS blocked this: allow ${hostAppName()} under Privacy & Security → Accessibility.`);
    }
    throw new Error(err || `${cmd} failed`);
  }
  return r.stdout;
}

function runShell(command: string, timeoutMs = 30000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const shell = process.env.SHELL || '/bin/sh';
    const child = spawn(shell, ['-lc', command], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const t = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.stdout.on('data', (d) => (stdout = (stdout + d).slice(-65536)));
    child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-65536)));
    child.on('close', (code) => {
      clearTimeout(t);
      resolve({ code: code ?? 1, stdout, stderr });
    });
    child.on('error', (e) => {
      clearTimeout(t);
      resolve({ code: 1, stdout, stderr: e.message });
    });
  });
}

// macOS virtual key codes (Carbon kVK_*), layout-independent.
const MAC_KEYCODES: Record<string, number> = {
  a: 0, s: 1, d: 2, f: 3, h: 4, g: 5, z: 6, x: 7, c: 8, v: 9, b: 11, q: 12, w: 13, e: 14, r: 15, y: 16, t: 17,
  '1': 18, '2': 19, '3': 20, '4': 21, '6': 22, '5': 23, '=': 24, '9': 25, '7': 26, '-': 27, '8': 28, '0': 29,
  ']': 30, o: 31, u: 32, '[': 33, i: 34, p: 35, l: 37, j: 38, "'": 39, k: 40, ';': 41, '\\': 42, ',': 43, '/': 44,
  n: 45, m: 46, '.': 47, '`': 50,
  Enter: 36, Tab: 48, Space: 49, Backspace: 51, Escape: 53, Delete: 117, Home: 115, End: 119, PageUp: 116, PageDown: 121,
  Left: 123, Right: 124, Down: 125, Up: 126,
  F1: 122, F2: 120, F3: 99, F4: 118, F5: 96, F6: 97, F7: 98, F8: 100, F9: 101, F10: 109, F11: 103, F12: 111,
  F13: 105, F14: 107, F15: 113, F16: 106, F17: 64, F18: 79, F19: 80, F20: 90,
};

export const MAC_CONTROLS = [
  { value: 'darkmode', label: 'Toggle dark mode', icon: 'sun-moon', needs: 'automation' },
  { value: 'lock', label: 'Lock screen', icon: 'lock', needs: 'accessibility' },
  { value: 'displaysleep', label: 'Turn display off', icon: 'monitor-off', needs: '' },
  { value: 'sleep', label: 'Sleep the Mac', icon: 'moon', needs: '' },
  { value: 'screensaver', label: 'Start screen saver', icon: 'monitor-play', needs: '' },
  { value: 'missioncontrol', label: 'Mission Control', icon: 'panels-top-left', needs: '' },
  { value: 'showdesktop', label: 'Show desktop', icon: 'monitor', needs: '' },
  { value: 'apps', label: 'Show all apps (Launchpad)', icon: 'layout-grid', needs: '' },
  { value: 'spotlight', label: 'Spotlight search', icon: 'search', needs: 'accessibility' },
  { value: 'emoji', label: 'Emoji & symbols', icon: 'smile', needs: 'accessibility' },
  { value: 'screenshot', label: 'Screenshot tools', icon: 'camera', needs: '' },
  { value: 'forcequit', label: 'Force Quit dialog', icon: 'octagon-x', needs: 'accessibility' },
  { value: 'brightup', label: 'Display brighter', icon: 'sun', needs: 'accessibility' },
  { value: 'brightdown', label: 'Display dimmer', icon: 'sun-dim', needs: 'accessibility' },
] as const;
export type MacControlOp = (typeof MAC_CONTROLS)[number]['value'];

// NX_KEYTYPE_* for media keys
const NX: Record<MediaCmd, number> = { volup: 0, voldown: 1, mute: 7, playpause: 16, next: 17, previous: 18 };

const asStr = (s: string) => JSON.stringify(s);

export class MacPlatform implements Platform {
  readonly os = 'macos';
  readonly canExecute = true;
  private trusted: boolean | null = null;
  private trustedAt = 0;
  private trustError = '';
  private automation: boolean | null = null;
  private automationProbedAt = 0;
  private pasteQueue: Promise<void> = Promise.resolve();
  private volumeQueue: Promise<void> = Promise.resolve();
  private execute: CommandRunner;

  constructor(execute: CommandRunner = exec) {
    this.execute = execute;
  }

  private async mustExec(cmd: string, args: string[], input?: string, timeout?: number): Promise<string> {
    try {
      return await mustExec(cmd, args, this.execute, input, timeout);
    } catch (e) {
      if (e instanceof PermissionError && e.permission === 'automation' && cmd === 'osascript' && args[0] === '-e' && args[1]?.startsWith('tell application "System Events"')) this.automation = false;
      throw e;
    }
  }

  /** AXIsProcessTrusted for the responsible app. Without it macOS silently drops posted media/scroll events. */
  private async isTrusted(prompt = false, refresh = false): Promise<boolean | null> {
    if (!refresh && !prompt && this.trusted !== null && Date.now() - this.trustedAt < 4000) return this.trusted;
    const js = prompt
      ? "ObjC.import('ApplicationServices'); $.AXIsProcessTrustedWithOptions($({AXTrustedCheckOptionPrompt: true}))"
      : "ObjC.import('ApplicationServices'); $.AXIsProcessTrusted()";
    const r = await this.execute('osascript', ['-l', 'JavaScript', '-e', js]);
    const value = r.stdout.trim();
    this.trusted = r.code === 0 && (value === 'true' || value === 'false') ? value === 'true' : null;
    this.trustError = this.trusted === null ? r.stderr.trim() || 'The permission checker returned no result.' : '';
    this.trustedAt = Date.now();
    return this.trusted;
  }

  private async needAccessibility(what: string): Promise<void> {
    const trusted = await this.isTrusted();
    if (trusted === null) throw new Error(`Couldn't check Accessibility: ${this.trustError}`);
    if (!trusted) {
      throw new PermissionError('accessibility', `${what} needs Accessibility permission for ${hostAppName()} (Privacy & Security → Accessibility).`);
    }
  }

  async checkPermissions(prompt = false, probeAutomation = false): Promise<PermissionCheck[]> {
    const host = hostAppName();
    const ax = await this.isTrusted(prompt, true);
    // Asking System Events for something harmless triggers macOS's consent prompt the first time.
    // Once the answer is "denied", re-probing shows no prompt (macOS only asks while undecided), so a
    // passive check re-probes at most every 3 s to notice when the user turns it on in System Settings.
    const reprobe = !probeAutomation && this.automation === false && Date.now() - this.automationProbedAt > 3000;
    if (probeAutomation || reprobe) this.automationProbedAt = Date.now();
    const ae = probeAutomation || reprobe
      ? await this.execute('osascript', ['-e', 'tell application "System Events" to return name of first application process whose frontmost is true'], 15000)
      : null;
    if (ae) this.automation = ae.code === 0 ? true : /-1743|Not authori[sz]ed/i.test(ae.stderr) ? false : null;
    const aeOk = this.automation;
    return [
      {
        id: 'accessibility',
        ok: ax,
        label: 'Accessibility',
        detail: ax === null
          ? `Couldn't check: ${this.trustError.slice(0, 160)}`
          : ax ? `${host} can send keys, media keys and scrolling.` : `Turn on ${host} in Privacy & Security → Accessibility. Needed for Hotkey, Text, track controls and Mouse Wheel.`,
      },
      {
        id: 'automation',
        ok: aeOk,
        label: 'Automation → System Events',
        detail: aeOk
          ? `${host} can control System Events.`
          : aeOk === false
            ? `Turn on System Events under ${host} in Privacy & Security → Automation. Needed for Hotkey and Text.`
            : ae
              ? `Couldn't check: ${ae.stderr.trim().slice(0, 120)}`
              : 'Not checked yet. Check again to find out (macOS may ask you to allow it).',
      },
    ];
  }

  async openPermissionSettings(id: 'accessibility' | 'automation') {
    await this.mustExec('open', [`x-apple.systempreferences:com.apple.preference.security?${id === 'accessibility' ? 'Privacy_Accessibility' : 'Privacy_Automation'}`]);
  }

  openUrl(url: string) {
    return this.mustExec('open', [url]).then(() => undefined);
  }
  openPath(path: string) {
    const p = path.replace(/^~(?=\/|$)/, process.env.HOME ?? '~');
    // "Safari" or "Safari.app" → open -a
    const args = /\.app\/?$/.test(p) || (!p.includes('/') && !/^[a-z]+:/i.test(p)) ? ['-a', p] : [p];
    return this.mustExec('open', args).then(() => undefined);
  }
  async launchAgent(options: AgentLaunchOptions): Promise<void> {
    const launch = prepareAgentLaunch(options);
    try {
      await this.mustExec('osascript', ['-e', TERMINAL_LAUNCH_SCRIPT, launch.terminalCommand]);
    } catch (e) {
      if (e instanceof PermissionError && e.permission === 'automation') {
        throw new PermissionError('automation', `macOS blocked this: allow ${hostAppName()} to control Terminal (Privacy & Security → Automation).`);
      }
      throw e;
    }
  }
  async hotkey(h: Hotkey) {
    await this.needAccessibility('Sending a shortcut');
    const mods = [h.cmd && 'command down', h.ctrl && 'control down', h.opt && 'option down', h.shift && 'shift down'].filter(Boolean);
    const using = mods.length ? ` using {${mods.join(', ')}}` : '';
    const code = MAC_KEYCODES[h.key] ?? MAC_KEYCODES[h.key.toLowerCase()];
    const stroke = code !== undefined ? `key code ${code}${using}` : `keystroke ${asStr(h.key)}${using}`;
    await this.mustExec('osascript', ['-e', `tell application "System Events" to ${stroke}`]);
    this.automation = true;
  }
  async typeText(text: string, opts: { enter?: boolean; paste?: boolean }) {
    if (opts.paste) {
      const paste = this.pasteQueue.then(async () => {
        await this.needAccessibility('Typing text');
        const previous = await this.mustExec('pbpaste', []);
        await this.mustExec('pbcopy', [], text);
        try {
          await this.hotkey({ key: 'v', cmd: true });
          if (opts.enter) await this.hotkey({ key: 'Enter' });
          await new Promise((resolve) => setTimeout(resolve, 400));
        } finally {
          // Don't overwrite a new clipboard value copied by the user or another app.
          const current = await this.mustExec('pbpaste', []);
          if (current === text) await this.mustExec('pbcopy', [], previous);
        }
      });
      this.pasteQueue = paste.catch(() => {});
      return paste;
    }
    await this.needAccessibility('Typing text');
    const script = `tell application "System Events" to keystroke ${asStr(text)}${opts.enter ? '\ntell application "System Events" to key code 36' : ''}`;
    await this.mustExec('osascript', ['-e', script]);
    this.automation = true;
  }
  async media(cmd: MediaCmd) {
    if (cmd === 'mute' || cmd === 'volup' || cmd === 'voldown') {
      const change = this.volumeQueue.then(async () => {
        const current = await this.getVolume();
        if (cmd === 'mute') await this.setMuted(!current.muted);
        else {
          const next = Math.max(0, Math.min(100, current.volume + (cmd === 'volup' ? 6 : -6)));
          await this.setVolume(next);
          // Like the keyboard's volume-up key: raising the level is audible again. `set volume`
          // alone leaves macOS's mute flag on (it is set when the level reaches zero).
          if (cmd === 'volup' && current.muted && next > 0) await this.setMuted(false);
        }
      });
      this.volumeQueue = change.catch(() => {});
      return change;
    }
    await this.needAccessibility('Media keys');
    const key = NX[cmd];
    const jxa = `ObjC.import('Cocoa');
function post(down){
  var flags = down ? 0xa00 : 0xb00;
  var data1 = (${key} << 16) | ((down ? 0xa : 0xb) << 8);
  var ev = $.NSEvent.otherEventWithTypeLocationModifierFlagsTimestampWindowNumberContextSubtypeData1Data2(14, $.NSMakePoint(0,0), flags, 0, 0, $(), 8, data1, -1);
  $.CGEventPost(0, ev.CGEvent);
}
post(true); post(false);`;
    await this.mustExec('osascript', ['-l', 'JavaScript', '-e', jxa]);
  }
  async getVolume() {
    const out = await this.mustExec('osascript', ['-e', 'set s to get volume settings\nreturn (output volume of s as text) & "," & (output muted of s as text)']);
    const [v, m] = out.trim().split(',');
    const volume = Number(v);
    // Outputs without software volume (some HDMI/USB devices) report "missing value". Treat that as
    // unknown, not as 0, so a "muted when silent" key does not get stuck on the muted icon.
    if (!Number.isFinite(volume)) throw new Error('This audio output has no adjustable volume');
    return { volume, muted: m === 'true' };
  }
  async setVolume(v: number) {
    await this.mustExec('osascript', ['-e', `set volume output volume ${Math.max(0, Math.min(100, Math.round(v)))}`]);
  }
  async setMuted(m: boolean) {
    await this.mustExec('osascript', ['-e', `set volume output muted ${m}`]);
  }
  async scroll(dx: number, dy: number) {
    await this.needAccessibility('Scrolling');
    const jxa = `ObjC.import('CoreGraphics');
var e = $.CGEventCreateScrollWheelEvent($(), 1, 2, ${Math.round(dy)}, ${Math.round(dx)});
$.CGEventPost(0, e);`;
    await this.mustExec('osascript', ['-l', 'JavaScript', '-e', jxa]);
  }
  run(command: string, timeoutMs?: number) {
    return runShell(command, timeoutMs);
  }
  runScript(options: ScriptCommandOptions) { return executeScript(options); }
  async runShortcut(name: string) {
    if (!name.trim() || name.trim().startsWith('-') || name.includes('\0')) throw new Error('Choose a valid shortcut name');
    await this.mustExec('/usr/bin/shortcuts', ['run', name.trim()], undefined, 300_000);
  }

  private async postSystemKey(key: number, what: string) {
    await this.needAccessibility(what);
    const jxa = `ObjC.import('Cocoa');
function post(down){
  var ev = $.NSEvent.otherEventWithTypeLocationModifierFlagsTimestampWindowNumberContextSubtypeData1Data2(14, $.NSMakePoint(0,0), down ? 0xa00 : 0xb00, 0, 0, $(), 8, (${key} << 16) | ((down ? 0xa : 0xb) << 8), -1);
  $.CGEventPost(0, ev.CGEvent);
}
post(true); post(false);`;
    await this.mustExec('osascript', ['-l', 'JavaScript', '-e', jxa]);
  }

  async macControl(op: MacControlOp) {
    switch (op) {
      case 'darkmode':
        await this.mustExec('osascript', ['-e', 'tell application "System Events" to tell appearance preferences to set dark mode to not dark mode']);
        this.automation = true;
        return;
      case 'lock':
        return this.hotkey({ key: 'q', cmd: true, ctrl: true });
      case 'displaysleep':
        await this.mustExec('/usr/bin/pmset', ['displaysleepnow']);
        return;
      case 'sleep':
        await this.mustExec('/usr/bin/pmset', ['sleepnow']);
        return;
      case 'screensaver':
        await this.mustExec('/usr/bin/open', ['-a', 'ScreenSaverEngine']);
        return;
      case 'missioncontrol':
        await this.mustExec('/usr/bin/open', ['-a', '/System/Applications/Mission Control.app']);
        return;
      case 'showdesktop':
        // Mission Control's documented "1" argument shows the desktop without a keyboard shortcut.
        await this.mustExec('/System/Applications/Mission Control.app/Contents/MacOS/Mission Control', ['1']);
        return;
      case 'apps': {
        const r = await this.execute('/usr/bin/open', ['-a', 'Launchpad']);
        if (r.code !== 0) await this.mustExec('/usr/bin/open', ['-a', 'Apps']);
        return;
      }
      case 'spotlight':
        return this.hotkey({ key: 'Space', cmd: true });
      case 'emoji':
        return this.hotkey({ key: 'Space', cmd: true, ctrl: true });
      case 'screenshot':
        await this.mustExec('/usr/bin/open', ['-a', '/System/Applications/Utilities/Screenshot.app']);
        return;
      case 'forcequit':
        return this.hotkey({ key: 'Escape', cmd: true, opt: true });
      case 'brightup':
        return this.postSystemKey(2, 'Display brightness');
      case 'brightdown':
        return this.postSystemKey(3, 'Display brightness');
      default:
        throw new Error(`Unknown Mac control ${String(op)}`);
    }
  }

  async readClipboard() {
    return (await this.execute('/usr/bin/pbpaste', [])).stdout;
  }

  async readState(source: StateSourceId, arg?: string): Promise<StateValue> {
    switch (source) {
      case 'volume': return (await this.getVolume()).volume;
      case 'muted': return (await this.getVolume()).muted;
      case 'micMuted': {
        const level = Number((await this.mustExec('osascript', ['-e', 'input volume of (get volume settings)'])).trim());
        if (!Number.isFinite(level)) throw new Error('This microphone has no adjustable level');
        return level === 0;
      }
      case 'darkMode': {
        // The key only exists while dark mode is on.
        const r = await this.execute('/usr/bin/defaults', ['read', '-g', 'AppleInterfaceStyle']);
        return r.code === 0 && r.stdout.trim() === 'Dark';
      }
      case 'frontApp': {
        const asn = (await this.mustExec('/usr/bin/lsappinfo', ['front'])).trim();
        if (!asn) throw new Error('No app is in front');
        // First line: "Name" ASN:0x0-0x1234: (in front)
        const name = /^"(.*)" ASN:/.exec(await this.mustExec('/usr/bin/lsappinfo', ['info', '-only', 'name', asn]))?.[1];
        if (name === undefined) throw new Error('Could not read the app in front');
        return name;
      }
      case 'appRunning': {
        const want = appNameKey(arg ?? '');
        if (!want) throw new Error('Enter an app name');
        return runningAppNames(await this.mustExec('/usr/bin/lsappinfo', ['list'])).has(want);
      }
      case 'battery': {
        const level = /(\d+)%/.exec(await this.mustExec('/usr/bin/pmset', ['-g', 'batt']))?.[1];
        if (level === undefined) throw new Error('This Mac has no battery');
        return Number(level);
      }
      case 'pluggedIn':
        return /'AC Power'/.test(await this.mustExec('/usr/bin/pmset', ['-g', 'batt']));
    }
    throw new Error(`Unknown state ${String(source)}`);
  }

  async keepAwake(on: boolean) {
    return setCaffeinate(on);
  }
  isAwake() {
    return !!caffeinate;
  }
}

/** App names compare without case or a trailing ".app": "zoom.us", "Zoom.us.app". */
export function appNameKey(name: string): string {
  return name.trim().replace(/\.app$/i, '').trim().toLowerCase();
}

/**
 * Every running app from `lsappinfo list`, by its name and by its bundle's file name, since they can
 * differ (Visual Studio Code.app runs as "Code"). Entries look like:
 *   82) "Google Chrome" ASN:0x0-0x36b96b6:
 *       bundle path="/Applications/Google Chrome.app"
 */
export function runningAppNames(list: string): Set<string> {
  const names = new Set<string>();
  for (const m of list.matchAll(/^\s*\d+\) "(.*)" ASN:/gm)) names.add(appNameKey(m[1]!));
  for (const m of list.matchAll(/^\s*bundle path="(?:[^"]*\/)?([^"/]+\.app)"/gm)) names.add(appNameKey(m[1]!));
  names.delete('');
  return names;
}

// One caffeinate process for the whole server, shared across platform instances (toggling
// dry run replaces the platform) and every Keep Awake button. `-w <pid>` makes it exit with
// this server even after SIGKILL/SIGHUP, so it can never outlive the app.
let caffeinate: ReturnType<typeof spawn> | null = null;
let caffeinateHooked = false;
let awakeListener: ((on: boolean) => void) | null = null;
/** Told whenever Keep Awake turns on or off, so a supervised service can restore it after a crash. */
export function onKeepAwakeChange(listener: ((on: boolean) => void) | null): void {
  awakeListener = listener;
}
function setCaffeinate(on: boolean): boolean {
  const before = !!caffeinate;
  if (on && !caffeinate) {
    const child = spawn('/usr/bin/caffeinate', ['-di', '-w', String(process.pid)], { stdio: 'ignore' });
    const gone = () => { if (caffeinate === child) { caffeinate = null; awakeListener?.(false); } };
    child.on('error', gone);
    child.on('exit', gone);
    caffeinate = child;
    if (!caffeinateHooked) {
      caffeinateHooked = true;
      process.once('exit', () => caffeinate?.kill());
    }
  } else if (!on && caffeinate) {
    caffeinate.kill();
    caffeinate = null;
  }
  if (before !== !!caffeinate) awakeListener?.(!!caffeinate);
  return !!caffeinate;
}

class GenericPlatform implements Platform {
  readonly os: string;
  readonly canExecute: boolean;
  private volume = 50;
  private muted = false;
  constructor(os: string, canExecute: boolean) {
    this.os = os;
    this.canExecute = canExecute;
  }
  async checkPermissions(): Promise<PermissionCheck[]> {
    return [];
  }
  async openPermissionSettings() {}
  async openUrl(url: string) {
    await mustExec(this.os === 'windows' ? 'explorer' : 'xdg-open', [url]);
  }
  async openPath(path: string) {
    await mustExec(this.os === 'windows' ? 'explorer' : 'xdg-open', [path]);
  }
  async launchAgent(_options: AgentLaunchOptions): Promise<void> {
    throw new Error('Interactive agent launch is currently supported on macOS. Run the CLI in your terminal on this platform.');
  }
  async hotkey(h: Hotkey) {
    const combo = [h.ctrl && 'ctrl', h.opt && 'alt', h.shift && 'shift', h.cmd && 'super', h.key].filter(Boolean).join('+');
    await mustExec('xdotool', ['key', combo]);
  }
  async typeText(text: string, opts: { enter?: boolean }) {
    await mustExec('xdotool', ['type', '--', text]);
    if (opts.enter) await mustExec('xdotool', ['key', 'Return']);
  }
  async media(cmd: MediaCmd) {
    const map: Record<MediaCmd, string> = {
      playpause: 'XF86AudioPlay', next: 'XF86AudioNext', previous: 'XF86AudioPrev',
      mute: 'XF86AudioMute', volup: 'XF86AudioRaiseVolume', voldown: 'XF86AudioLowerVolume',
    };
    await mustExec('xdotool', ['key', map[cmd]]);
  }
  async getVolume() {
    return { volume: this.volume, muted: this.muted };
  }
  async setVolume(v: number) {
    this.volume = Math.max(0, Math.min(100, v));
    await exec('pactl', ['set-sink-volume', '@DEFAULT_SINK@', `${Math.round(this.volume)}%`]);
  }
  async setMuted(m: boolean) {
    this.muted = m;
    await exec('pactl', ['set-sink-mute', '@DEFAULT_SINK@', m ? '1' : '0']);
  }
  async scroll(_dx: number, dy: number) {
    const btn = dy > 0 ? '4' : '5';
    for (let i = 0; i < Math.abs(Math.round(dy)); i++) await mustExec('xdotool', ['click', btn]);
  }
  run(command: string, timeoutMs?: number) {
    return runShell(command, timeoutMs);
  }
  runScript(options: ScriptCommandOptions) { return executeScript(options); }
  async runShortcut(_name: string): Promise<void> { throw new Error('Apple Shortcuts require macOS'); }
  async macControl(op: MacControlOp): Promise<void> { throw new Error(`${op} requires macOS`); }
  async keepAwake(_on: boolean): Promise<boolean> { throw new Error('Keep awake requires macOS'); }
  isAwake() { return false; }
  async readState(source: StateSourceId): Promise<StateValue> {
    if (source === 'volume') return this.volume;
    if (source === 'muted') return this.muted;
    throw new Error(`Reading ${source} requires macOS`);
  }
}

/** Logs instead of acting. Volume is simulated so dial UIs still work. */
/** Dry-run Keep Awake state, shared like the real one. */
let dryRunAwake = false;

export class DryRunPlatform implements Platform {
  readonly os: string;
  readonly canExecute = false;
  private volume = 40;
  private muted = false;
  private log: (msg: string) => void;
  /** Simulated computer state for state rules (volume and mute follow the simulated audio). */
  readonly simulated: Partial<Record<string, StateValue>> = {
    micMuted: false, darkMode: false, frontApp: 'Finder', battery: 80, pluggedIn: true,
  };
  constructor(os: string, log: (msg: string) => void) {
    this.os = os;
    this.log = log;
  }
  async checkPermissions(): Promise<PermissionCheck[]> { return []; }
  async openPermissionSettings() {}
  async openUrl(url: string) { this.log(`open URL ${url}`); }
  async openPath(path: string) { this.log(`open ${path}`); }
  async launchAgent(options: AgentLaunchOptions) {
    this.log(`launch ${options.tool} (${options.mode ?? 'new'}) in ${options.cwd}${options.prompt ? `: ${JSON.stringify(options.prompt)}` : ''}`);
  }
  async hotkey(h: Hotkey) { this.log(`hotkey ${formatHotkey(h)}`); }
  async typeText(text: string, o: { enter?: boolean; paste?: boolean }) { this.log(`${o.paste ? 'paste' : 'type'} ${JSON.stringify(text)}${o.enter ? ' ⏎' : ''}`); }
  async media(cmd: MediaCmd) {
    if (cmd === 'volup') { this.volume = Math.min(100, this.volume + 6); if (this.volume > 0) this.muted = false; }
    if (cmd === 'voldown') this.volume = Math.max(0, this.volume - 6);
    if (cmd === 'mute') this.muted = !this.muted;
    this.log(`media ${cmd}`);
  }
  async getVolume() { return { volume: this.volume, muted: this.muted }; }
  async setVolume(v: number) { this.volume = Math.max(0, Math.min(100, v)); }
  async setMuted(m: boolean) { this.muted = m; this.log(m ? 'mute' : 'unmute'); }
  async scroll(dx: number, dy: number) { this.log(`scroll ${dx},${dy}`); }
  async run(command: string) {
    this.log(`run: ${command}`);
    return { code: 0, stdout: '', stderr: '' };
  }
  async runScript(options: ScriptCommandOptions) {
    this.log(`script ${options.path} ${JSON.stringify(options.args ?? [])}`);
    return { code: 0, stdout: '', stderr: '' };
  }
  async runShortcut(name: string) { this.log(`shortcut ${name}`); }
  async macControl(op: MacControlOp) { this.log(`mac control ${op}`); }
  async keepAwake(on: boolean) { dryRunAwake = on; this.log(on ? 'keep awake on' : 'keep awake off'); return dryRunAwake; }
  isAwake() { return dryRunAwake; }
  async readState(source: StateSourceId, arg?: string): Promise<StateValue> {
    if (source === 'volume') return this.volume;
    if (source === 'muted') return this.muted;
    if (source === 'appRunning') {
      const want = appNameKey(arg ?? '');
      return Object.entries(this.simulated).some(([k, v]) => k.startsWith('appRunning:') && appNameKey(k.slice(11)) === want && v === true);
    }
    const value = this.simulated[source];
    if (value === undefined) throw new Error(`No simulated value for ${source}`);
    return value;
  }
}

export function formatHotkey(h: Hotkey | undefined | null): string {
  if (!h || !h.key) return '';
  return `${h.ctrl ? '⌃' : ''}${h.opt ? '⌥' : ''}${h.shift ? '⇧' : ''}${h.cmd ? '⌘' : ''}${h.key.length === 1 ? h.key.toUpperCase() : h.key}`;
}

export function detectOs(): string {
  const p = osPlatform();
  return p === 'darwin' ? 'macos' : p === 'win32' ? 'windows' : p;
}

export function createPlatform(execute: boolean, log: (m: string) => void): Platform {
  const os = detectOs();
  if (!execute) return new DryRunPlatform(os, log);
  if (os === 'macos') return new MacPlatform();
  return new GenericPlatform(os, true);
}
