// Built-in action catalog: metadata (sent to the UI) + behavior. Mirrors the Elgato built-ins
// (com.elgato.streamdeck.system.*, page.*, profile.*, multiactions.*) found in the app bundle.

import type { ActionInstance, ActionMeta, Hotkey } from '../shared/types.ts';
import type { MediaCmd, Platform } from './platform.ts';
import { formatHotkey, MAC_CONTROLS, type MacControlOp } from './platform.ts';
import type { TouchVisual } from '../render/renderer.ts';
import { validateActionSetup } from '../shared/action-setup.ts';

export interface SessionApi {
  nextPage(): void;
  prevPage(): void;
  gotoPage(id: string): void;
  openFolder(id: string): void;
  back(): void;
  switchProfile(id: string): void;
  brightness: number;
  setBrightness(v: number): void;
  sleepDisplay(): void;
  pageInfo(): { index: number; count: number; name: string };
}

export interface ActionCtx {
  instance: ActionInstance;
  settings: Record<string, any>;
  state: Record<string, any>;
  platform: Platform;
  session: SessionApi;
  controller: 'key' | 'dial';
  refresh(): void;
  refreshVolumeKeys(): Promise<void>;
  showOk(): void;
  showAlert(): void;
  log(msg: string): void;
  runInstance(inst: ActionInstance): Promise<void>;
}

export interface KeyDynamic {
  title?: string;
  value?: string;
  progress?: number | null;
  state?: number;
  icon?: string;
  iconOverride?: string;
}

export interface ActionDef {
  meta: ActionMeta;
  keyDown?(c: ActionCtx): Promise<void> | void;
  keyUp?(c: ActionCtx, heldMs: number): Promise<void> | void;
  longPress?(c: ActionCtx): Promise<void> | void;
  dialRotate?(c: ActionCtx, ticks: number): Promise<void> | void;
  dialDown?(c: ActionCtx): Promise<void> | void;
  dialUp?(c: ActionCtx, heldMs: number): Promise<void> | void;
  touchTap?(c: ActionCtx): Promise<void> | void;
  touchLong?(c: ActionCtx): Promise<void> | void;
  appear?(c: ActionCtx): Promise<void> | void;
  key?(c: ActionCtx): KeyDynamic;
  touch?(c: ActionCtx): Partial<TouchVisual>;
  /** Re-render interval in ms (clock, timers). */
  live?: number;
}

const hk = (v: unknown): Hotkey | null => (v && typeof v === 'object' && (v as Hotkey).key ? (v as Hotkey) : null);
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Coalesce rapid dial ticks into one platform call (osascript costs ~50 ms). */
function coalesced(state: Record<string, any>, key: string, fn: () => Promise<void>): void {
  if (state[key]) {
    state[key + ':again'] = true;
    return;
  }
  state[key] = true;
  void (async () => {
    try {
      do {
        state[key + ':again'] = false;
        await fn();
      } while (state[key + ':again']);
    } finally {
      state[key] = false;
    }
  })();
}

const MEDIA_OPTIONS = [
  { value: 'playpause', label: 'Play / Pause' },
  { value: 'next', label: 'Next track' },
  { value: 'previous', label: 'Previous track' },
  { value: 'mute', label: 'Mute' },
  { value: 'volup', label: 'Volume up' },
  { value: 'voldown', label: 'Volume down' },
];
const MEDIA_ICONS: Record<string, string> = {
  playpause: 'circle-play', next: 'skip-forward', previous: 'skip-back', mute: 'volume-x', volup: 'volume-2', voldown: 'volume-1',
};

export function hasSilentVolumeIcon(action: ActionInstance | null | undefined): boolean {
  return action?.type === 'system.volume' && action.settings.mutedIconWhenSilent === true;
}

async function syncVolume(c: ActionCtx) {
  try {
    const v = await c.platform.getVolume();
    c.state.volume = v.volume;
    c.state.muted = v.muted;
  } catch {
    /* keep last */
  }
  c.refresh();
}

export const ACTIONS: ActionDef[] = [
  ...(['codex', 'claude'] as const).map((tool): ActionDef => ({
    meta: {
      type: `agent.${tool}`, name: tool === 'codex' ? 'Codex CLI' : 'Claude Code', category: 'AI & coding',
      icon: tool === 'codex' ? 'terminal' : 'sparkles', color: tool === 'codex' ? '#60a5fa' : '#f5ab78',
      description: `Open ${tool === 'codex' ? 'Codex' : 'Claude Code'} in Terminal with your project and an optional task.`,
      controllers: ['key'],
      fields: [
        { key: 'cwd', label: 'Project folder', type: 'text', placeholder: '~/repos/my-project', required: true, browse: 'folder', help: 'An existing folder on this Mac. The agent opens here.' },
        { key: 'mode', label: 'Session', type: 'select', options: [{ value: 'new', label: 'Start a new session' }, { value: 'continue', label: 'Continue the last session in this project' }] },
        { key: 'prompt', label: 'Starting task (optional)', type: 'textarea', placeholder: 'Review the current changes and suggest improvements.', help: 'Leave empty to open the agent. A saved task starts when you press or test the button.' },
      ],
      defaults: { cwd: '', mode: 'new', prompt: '' },
    },
    async keyDown(c) {
      if (c.state.launching) return;
      const error = validateActionSetup(ACTION_MAP.get(c.instance.type)!.meta, c.settings, 'key')[0];
      if (error) throw new Error(error);
      c.state.launching = true;
      try {
        await c.platform.launchAgent({ tool, cwd: String(c.settings.cwd), mode: c.settings.mode === 'continue' ? 'continue' : 'new', prompt: String(c.settings.prompt || '') });
        c.log(`${tool === 'codex' ? 'Codex' : 'Claude Code'} ${c.platform.canExecute ? 'handed off to Terminal' : 'launch simulated (dry run)'}`);
        c.showOk();
      } finally { c.state.launching = false; }
    },
  })),
  ...(['raycast', 'asyar'] as const).map((provider): ActionDef => ({
    meta: {
      type: `system.${provider}`, name: `${provider === 'raycast' ? 'Raycast' : 'Asyar'} Command`, category: 'Apps & links',
      icon: provider === 'raycast' ? 'command' : 'search', color: provider === 'raycast' ? '#fb7185' : '#a78bfa',
      description: `Launch an installed ${provider === 'raycast' ? 'Raycast' : 'Asyar'} command using its copied deep link.`, controllers: ['key'],
      fields: [{ key: 'url', label: 'Command deep link', type: 'text', placeholder: `${provider}://extensions/…`, required: true, help: provider === 'raycast' ? 'In Raycast, select a command → Action Panel → Copy Deeplink. Paste the entire link, including arguments.' : 'Paste an Asyar extension command link. The matching extension must be installed.' }],
      defaults: { url: '' },
    },
    async keyDown(c) {
      const error = validateActionSetup(ACTION_MAP.get(c.instance.type)!.meta, c.settings, 'key')[0];
      if (error) throw new Error(error);
      await c.platform.openUrl(String(c.settings.url).trim());
      if (c.platform.canExecute) c.log(`Command handed off to ${provider === 'raycast' ? 'Raycast' : 'Asyar'}`);
    },
  })),
  {
    meta: {
      type: 'system.shortcut', name: 'Apple Shortcut', category: 'Mac controls', icon: 'workflow', color: '#a78bfa',
      description: 'Run a shortcut you have already created in the Shortcuts app.', controllers: ['key'],
      fields: [{ key: 'name', label: 'Shortcut name', type: 'text', placeholder: 'Focus time', required: true, help: 'Use the exact name shown in Apple Shortcuts. Its own permission prompts still apply.' }], defaults: { name: '' },
    },
    async keyDown(c) {
      const name = String(c.settings.name || '').trim();
      if (!name) throw new Error('Choose a shortcut name first');
      await c.platform.runShortcut(name);
      c.showOk();
    },
  },
  {
    meta: {
      type: 'system.script', name: 'Script Command', category: 'Scripts', icon: 'file-code', color: '#34d399',
      description: 'Run an executable script with literal arguments. Supports Raycast script metadata.', controllers: ['key'],
      fields: [
        { key: 'path', label: 'Executable script', type: 'text', placeholder: '~/scripts/my-command.sh', required: true, browse: 'file', help: 'An executable file with a shebang. Inspect reads its metadata without running it.' },
        { key: 'arg1', label: 'Argument 1 (optional)', type: 'text' },
        { key: 'arg2', label: 'Argument 2 (optional)', type: 'text' },
        { key: 'arg3', label: 'Argument 3 (optional)', type: 'text' },
        { key: 'showOutput', label: 'Show first line of output on the button', type: 'toggle' },
      ], defaults: { path: '', arg1: '', arg2: '', arg3: '', showOutput: true },
    },
    async keyDown(c) {
      if (c.state.running) return;
      c.state.running = true;
      c.state.lastScriptOutput = '';
      try {
        const args = [c.settings.arg1, c.settings.arg2, c.settings.arg3].map((v) => String(v ?? ''));
        while (args.length && args.at(-1) === '') args.pop();
        const result = await c.platform.runScript({ path: String(c.settings.path || ''), args });
        c.state.lastScriptOutput = result.stdout.trim().slice(0, 4000);
        if (result.code !== 0) throw new Error(`Script exited ${result.code}: ${result.stderr.trim().slice(0, 180)}`);
        if (c.settings.showOutput) { c.state.output = result.stdout.trim().split('\n')[0]?.slice(0, 40) || ''; c.refresh(); }
        c.showOk();
      } finally { c.state.running = false; }
    },
    key(c) { return c.settings.showOutput && c.state.output ? { value: String(c.state.output) } : {}; },
  },
  // ---------------------------------------------------------------------------------- System
  {
    meta: {
      type: 'system.mac', name: 'Mac Control', category: 'System', icon: 'laptop', color: '#38bdf8',
      description: 'Dark mode, lock screen, display sleep, Mission Control and other built-in Mac controls',
      controllers: ['key'],
      fields: [{ key: 'op', label: 'Control', type: 'select', options: MAC_CONTROLS.map((m) => ({ value: m.value, label: m.label })) }],
      defaults: { op: 'darkmode' },
    },
    async keyDown(c) {
      const op = String(c.settings.op || '') as MacControlOp;
      if (!MAC_CONTROLS.some((m) => m.value === op)) return c.showAlert();
      await c.platform.macControl(op);
    },
    key(c) {
      return { icon: MAC_CONTROLS.find((m) => m.value === c.settings.op)?.icon };
    },
  },
  {
    meta: {
      type: 'util.awake', name: 'Keep Awake', category: 'System', icon: 'coffee', color: '#fbbf24',
      description: 'Press to keep your Mac and display awake; press again to allow sleep', controllers: ['key'],
      fields: [], defaults: {},
    },
    // Every Keep Awake button reflects the one shared state, including changes made elsewhere.
    live: 1000,
    async keyDown(c) {
      await c.platform.keepAwake(!c.platform.isAwake());
      c.refresh();
    },
    key(c) {
      return c.platform.isAwake() ? { state: 1, icon: 'coffee', value: 'On' } : { state: 0, icon: 'coffee' };
    },
  },
  {
    meta: {
      type: 'system.website', name: 'Website', category: 'System', icon: 'globe', color: '#60a5fa',
      description: 'Open a URL in the default browser', controllers: ['key'],
      fields: [{ key: 'url', label: 'URL', type: 'text', placeholder: 'https://' }],
      defaults: { url: 'https://www.elgato.com' }, elgato: ['com.elgato.streamdeck.system.website'],
    },
    async keyDown(c) {
      let url = String(c.settings.url || '').trim();
      if (!url) return c.showAlert();
      if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) url = `https://${url}`;
      await c.platform.openUrl(url);
    },
  },
  {
    meta: {
      type: 'system.open', name: 'Open', category: 'System', icon: 'app-window', color: '#a78bfa',
      description: 'Open an app, file or folder', controllers: ['key'],
      fields: [{ key: 'path', label: 'App or path', type: 'text', required: true, placeholder: 'Safari  or  /Applications/Notes.app  or  ~/Downloads', browse: 'app', suggest: 'apps', help: 'Type an app name, or Browse for any app. Folders and files work too.' }],
      defaults: { path: '' }, elgato: ['com.elgato.streamdeck.system.open', 'com.elgato.streamdeck.system.openapp'],
    },
    async keyDown(c) {
      const p = String(c.settings.path || '').trim();
      if (!p) return c.showAlert();
      await c.platform.openPath(p);
    },
  },
  {
    meta: {
      type: 'system.hotkey', name: 'Hotkey', category: 'System', icon: 'keyboard', color: '#f472b6',
      description: 'Send a keyboard shortcut. On a dial: separate shortcuts for left, right and press.', controllers: ['key', 'dial'],
      fields: [
        { key: 'hotkey', label: 'Shortcut', type: 'hotkey', controllers: ['key'] },
        { key: 'left', label: 'Rotate left', type: 'hotkey', controllers: ['dial'] },
        { key: 'right', label: 'Rotate right', type: 'hotkey', controllers: ['dial'] },
        { key: 'press', label: 'Press', type: 'hotkey', controllers: ['dial'] },
      ],
      defaults: { hotkey: null, left: null, right: null, press: null }, elgato: ['com.elgato.streamdeck.system.hotkey'],
    },
    async keyDown(c) {
      const h = hk(c.settings.hotkey);
      if (!h) return c.showAlert();
      await c.platform.hotkey(h);
    },
    async dialRotate(c, ticks) {
      const h = hk(ticks < 0 ? c.settings.left : c.settings.right);
      if (!h) return;
      for (let i = 0; i < Math.min(Math.abs(ticks), 10); i++) await c.platform.hotkey(h);
    },
    async dialDown(c) {
      const h = hk(c.settings.press);
      if (h) await c.platform.hotkey(h);
    },
    touch(c) {
      const l = formatHotkey(hk(c.settings.left));
      const r = formatHotkey(hk(c.settings.right));
      return { layout: 'value', value: l || r ? `${l || '–'}  ${r || '–'}` : '' };
    },
  },
  {
    meta: {
      type: 'system.text', name: 'Text', category: 'System', icon: 'type', color: '#fbbf24',
      description: 'Type or paste a snippet of text', controllers: ['key'],
      fields: [
        { key: 'text', label: 'Text', type: 'textarea', help: 'Tokens: {date} {time} {weekday} {isodate} {clipboard} are filled in when you press the button.' },
        { key: 'paste', label: 'Paste instead of typing (restores clipboard text)', type: 'toggle' },
        { key: 'enter', label: 'Press Enter afterwards', type: 'toggle' },
      ],
      defaults: { text: '', paste: true, enter: false }, elgato: ['com.elgato.streamdeck.system.text'],
    },
    async keyDown(c) {
      const raw = String(c.settings.text ?? '');
      if (!raw) return c.showAlert();
      const t = TEXT_TOKEN.test(raw) ? await expandTextTokens(raw, c.platform) : raw;
      await c.platform.typeText(t, { paste: !!c.settings.paste, enter: !!c.settings.enter });
    },
  },
  {
    meta: {
      type: 'system.command', name: 'Run Command', category: 'System', icon: 'square-terminal', color: '#34d399',
      description: 'Run a shell command. Dials run separate commands per direction; {ticks} is replaced with the step count.',
      controllers: ['key', 'dial'],
      fields: [
        { key: 'command', label: 'Command', type: 'textarea', placeholder: 'say hello', controllers: ['key'] },
        { key: 'left', label: 'Rotate left', type: 'textarea', controllers: ['dial'] },
        { key: 'right', label: 'Rotate right', type: 'textarea', controllers: ['dial'] },
        { key: 'press', label: 'Press', type: 'textarea', controllers: ['dial'] },
        { key: 'showOutput', label: 'Show the first line of output on the key or strip', type: 'toggle' },
      ],
      defaults: { command: '', left: '', right: '', press: '', showOutput: false },
    },
    async keyDown(c) {
      const cmd = String(c.settings.command || '').trim();
      if (!cmd) return c.showAlert();
      const r = await c.platform.run(cmd);
      if (c.settings.showOutput) {
        c.state.output = r.stdout.trim().split('\n')[0]?.slice(0, 40) ?? '';
        c.refresh();
      }
      if (r.code !== 0) {
        c.log(`command exited ${r.code}: ${r.stderr.trim().slice(0, 200)}`);
        c.showAlert();
      } else if (!c.settings.showOutput) c.showOk();
    },
    async dialRotate(c, ticks) {
      const cmd = String((ticks < 0 ? c.settings.left : c.settings.right) || '').trim();
      if (!cmd) return;
      const r = await c.platform.run(cmd.replaceAll('{ticks}', String(Math.abs(ticks))));
      if (c.settings.showOutput) {
        c.state.output = r.stdout.trim().split('\n')[0]?.slice(0, 24) ?? '';
        c.refresh();
      }
    },
    async dialDown(c) {
      const cmd = String(c.settings.press || '').trim();
      if (!cmd) return;
      const r = await c.platform.run(cmd);
      if (c.settings.showOutput) {
        c.state.output = r.stdout.trim().split('\n')[0]?.slice(0, 24) ?? '';
        c.refresh();
      }
    },
    key(c) {
      return c.settings.showOutput && c.state.output ? { value: String(c.state.output) } : {};
    },
    touch(c) {
      return { layout: 'value', value: c.settings.showOutput ? String(c.state.output ?? '') : '' };
    },
  },
  {
    meta: {
      type: 'system.multimedia', name: 'Media', category: 'System', icon: 'circle-play', color: '#4ade80',
      description: 'Play/pause, track skip and volume keys', controllers: ['key'],
      fields: [{ key: 'action', label: 'Action', type: 'select', options: MEDIA_OPTIONS }],
      defaults: { action: 'playpause' }, elgato: ['com.elgato.streamdeck.system.multimedia'],
    },
    async keyDown(c) {
      await c.platform.media(String(c.settings.action || 'playpause') as MediaCmd);
    },
    key(c) {
      return { icon: MEDIA_ICONS[String(c.settings.action)] ?? 'circle-play' };
    },
  },
  {
    meta: {
      type: 'system.volume', name: 'Volume', category: 'System', icon: 'volume-2', color: '#4ade80',
      description: 'Control system volume. Keys can show a muted icon at zero volume or while muted.', controllers: ['dial', 'key'],
      fields: [
        { key: 'step', label: 'Step per tick (%)', type: 'slider', min: 1, max: 10, step: 1, controllers: ['dial'] },
        { key: 'mode', label: 'Key action', type: 'select', controllers: ['key'], options: [
          { value: 'mute', label: 'Toggle mute' }, { value: 'up', label: 'Volume up' }, { value: 'down', label: 'Volume down' },
        ] },
        { key: 'mutedIconWhenSilent', label: 'Show muted icon when silent', type: 'toggle', controllers: ['key'],
          help: 'At zero volume or while muted, show a speaker with an X. The normal icon returns when sound is on.' },
      ],
      defaults: { step: 2, mode: 'mute', mutedIconWhenSilent: false },
    },
    appear(c) {
      if (c.controller !== 'key' || !hasSilentVolumeIcon(c.instance)) return syncVolume(c);
    },
    async dialRotate(c, ticks) {
      const step = Number(c.settings.step) || 2;
      c.state.volume = clamp((c.state.volume ?? 50) + ticks * step, 0, 100);
      if (c.state.muted) {
        c.state.muted = false;
        void c.platform.setMuted(false);
      }
      c.refresh();
      coalesced(c.state, 'busy', () => c.platform.setVolume(c.state.volume));
    },
    async dialDown(c) {
      c.state.muted = !c.state.muted;
      c.refresh();
      await c.platform.setMuted(c.state.muted);
    },
    touchTap(c) {
      return this.dialDown!(c);
    },
    async keyDown(c) {
      const mode = c.settings.mode ?? 'mute';
      if (c.platform.os === 'macos' || !c.platform.canExecute) {
        // Use the platform's queued read/modify/write so separate keys see the current volume.
        await c.platform.media(mode === 'mute' ? 'mute' : mode === 'up' ? 'volup' : 'voldown');
      } else if (mode === 'mute') {
        c.state.muted = !c.state.muted;
        await c.platform.setMuted(c.state.muted);
      } else {
        c.state.volume = clamp((c.state.volume ?? 50) + (mode === 'up' ? 6 : -6), 0, 100);
        await c.platform.setVolume(c.state.volume);
      }
      // One fresh reading updates every volume key on the page, so a Volume Up press also
      // clears the muted icon on a separate Volume Down key right away.
      await c.refreshVolumeKeys();
    },
    key(c) {
      if (hasSilentVolumeIcon(c.instance) && (c.state.muted || c.state.volume === 0)) {
        return { iconOverride: 'volume-x', progress: null };
      }
      if (c.state.muted) return { icon: 'volume-x', progress: null };
      const icon = c.settings.mode === 'down' ? 'volume-1' : 'volume-2';
      return typeof c.state.volume === 'number'
        ? { value: `${Math.round(c.state.volume)}%`, icon, progress: c.state.volume / 100 }
        : { icon };
    },
    touch(c) {
      return {
        layout: 'bar',
        value: c.state.muted ? '' : `${Math.round(c.state.volume ?? 0)}%`,
        indicator: c.state.muted ? 0 : (c.state.volume ?? 0) / 100,
        iconOverride: c.state.muted ? 'volume-x' : 'volume-2',
      } as Partial<TouchVisual>;
    },
  },
  {
    meta: {
      type: 'system.scroll', name: 'Mouse Wheel', category: 'System', icon: 'mouse', color: '#22d3ee',
      description: 'Turn to scroll the window under the pointer', controllers: ['dial'],
      fields: [
        { key: 'direction', label: 'Direction', type: 'select', options: [{ value: 'vertical', label: 'Vertical' }, { value: 'horizontal', label: 'Horizontal' }] },
        { key: 'speed', label: 'Lines per tick', type: 'slider', min: 1, max: 10, step: 1 },
        { key: 'invert', label: 'Invert', type: 'toggle' },
      ],
      defaults: { direction: 'vertical', speed: 3, invert: false }, elgato: ['com.elgato.streamdeck.system.mouse-wheel'],
    },
    async dialRotate(c, ticks) {
      const n = ticks * (Number(c.settings.speed) || 3) * (c.settings.invert ? 1 : -1);
      await (c.settings.direction === 'horizontal' ? c.platform.scroll(n, 0) : c.platform.scroll(0, n));
    },
    touch() {
      return { layout: 'icon' };
    },
  },
  // ---------------------------------------------------------------------------------- Stream Deck
  {
    meta: {
      type: 'sd.brightness', name: 'Brightness', category: 'Stream Deck', icon: 'sun', color: '#e0dd3d',
      description: 'Adjust the brightness of the Stream Deck', controllers: ['key', 'dial'],
      fields: [
        { key: 'mode', label: 'Key action', type: 'select', controllers: ['key'], options: [
          { value: 'cycle', label: 'Cycle 25 → 50 → 75 → 100' }, { value: 'up', label: 'Increase' }, { value: 'down', label: 'Decrease' }, { value: 'set', label: 'Set to value' },
        ] },
        { key: 'value', label: 'Value', type: 'slider', min: 0, max: 100, step: 5, controllers: ['key'] },
        { key: 'step', label: 'Step per tick', type: 'slider', min: 1, max: 20, step: 1, controllers: ['dial'] },
      ],
      defaults: { mode: 'cycle', value: 60, step: 5 }, elgato: ['com.elgato.streamdeck.system.keybrightness'],
    },
    keyDown(c) {
      const b = c.session.brightness;
      const mode = c.settings.mode ?? 'cycle';
      const v = mode === 'up' ? b + 10 : mode === 'down' ? b - 10 : mode === 'set' ? Number(c.settings.value) : [25, 50, 75, 100].find((x) => x > b) ?? 25;
      c.session.setBrightness(clamp(v, 0, 100));
    },
    dialRotate(c, ticks) {
      c.session.setBrightness(clamp(c.session.brightness + ticks * (Number(c.settings.step) || 5), 0, 100));
    },
    dialDown(c) {
      c.session.setBrightness(c.session.brightness > 10 ? 10 : 100);
    },
    key(c) {
      return { value: `${c.session.brightness}%`, progress: c.session.brightness / 100 };
    },
    touch(c) {
      return { layout: 'bar', value: `${c.session.brightness}%`, indicator: c.session.brightness / 100 };
    },
  },
  {
    meta: {
      type: 'sd.page.next', name: 'Next Page', category: 'Stream Deck', icon: 'chevron-right', color: '#94a3b8',
      description: 'Go to the next page', controllers: ['key'], fields: [], defaults: {}, elgato: ['com.elgato.streamdeck.page.next'],
    },
    keyDown(c) {
      c.session.nextPage();
    },
  },
  {
    meta: {
      type: 'sd.page.prev', name: 'Previous Page', category: 'Stream Deck', icon: 'chevron-left', color: '#94a3b8',
      description: 'Go to the previous page', controllers: ['key'], fields: [], defaults: {}, elgato: ['com.elgato.streamdeck.page.previous'],
    },
    keyDown(c) {
      c.session.prevPage();
    },
  },
  {
    meta: {
      type: 'sd.page.goto', name: 'Go to Page', category: 'Stream Deck', icon: 'file-symlink', color: '#94a3b8',
      description: 'Jump to a specific page', controllers: ['key'],
      fields: [{ key: 'pageId', label: 'Page', type: 'page' }], defaults: { pageId: '' }, elgato: ['com.elgato.streamdeck.page.goto'],
    },
    keyDown(c) {
      if (c.settings.pageId) c.session.gotoPage(String(c.settings.pageId));
      else c.showAlert();
    },
  },
  {
    meta: {
      type: 'sd.page.indicator', name: 'Page Indicator', category: 'Stream Deck', icon: 'layers', color: '#94a3b8',
      description: 'Shows the current page. Press for next page.', controllers: ['key', 'dial'], fields: [], defaults: {},
      elgato: ['com.elgato.streamdeck.page.indicator'],
    },
    keyDown(c) {
      c.session.nextPage();
    },
    dialRotate(c, t) {
      if (t > 0) c.session.nextPage();
      else c.session.prevPage();
    },
    key(c) {
      const p = c.session.pageInfo();
      return { value: `${p.index + 1}/${p.count}` };
    },
    touch(c) {
      const p = c.session.pageInfo();
      return { layout: 'value', value: `${p.index + 1}/${p.count}` };
    },
  },
  {
    meta: {
      type: 'sd.folder', name: 'Folder', category: 'Stream Deck', icon: 'folder', color: '#fb923c',
      description: 'Open a folder of more keys. Its first key returns to the parent.', controllers: ['key'],
      fields: [{ key: 'folderId', label: 'Folder', type: 'folder', help: 'Created automatically. Open it from the key or the page bar to edit.' }],
      defaults: { folderId: '' }, elgato: ['com.elgato.streamdeck.profile.openchild'],
    },
    keyDown(c) {
      if (c.settings.folderId) c.session.openFolder(String(c.settings.folderId));
      else c.showAlert();
    },
  },
  {
    meta: {
      type: 'sd.back', name: 'Parent Folder', category: 'Stream Deck', icon: 'corner-up-left', color: '#fb923c',
      description: 'Leave the current folder', controllers: ['key'], fields: [], defaults: {},
      elgato: ['com.elgato.streamdeck.profile.backtoparent'],
    },
    keyDown(c) {
      c.session.back();
    },
  },
  {
    meta: {
      type: 'sd.profile', name: 'Switch Profile', category: 'Stream Deck', icon: 'repeat', color: '#94a3b8',
      description: 'Switch this device to another profile', controllers: ['key'],
      fields: [{ key: 'profileId', label: 'Profile', type: 'profile' }], defaults: { profileId: '' },
      elgato: ['com.elgato.streamdeck.profile.rotate'],
    },
    keyDown(c) {
      if (c.settings.profileId) c.session.switchProfile(String(c.settings.profileId));
      else c.showAlert();
    },
  },
  {
    meta: {
      type: 'sd.sleep', name: 'Sleep', category: 'Stream Deck', icon: 'moon', color: '#94a3b8',
      description: 'Turn the display off. Any key wakes it.', controllers: ['key'], fields: [], defaults: {},
      elgato: ['com.elgato.streamdeck.system.sleep'],
    },
    keyDown(c) {
      c.session.sleepDisplay();
    },
  },
  {
    meta: {
      type: 'sd.multi', name: 'Multi Action', category: 'Stream Deck', icon: 'list-ordered', color: '#c084fc',
      description: 'Run several actions in order, with optional delays', controllers: ['key'],
      fields: [{ key: 'steps', label: 'Steps', type: 'steps' }],
      defaults: { steps: [] }, elgato: ['com.elgato.streamdeck.multiactions.routine'],
    },
    async keyDown(c) {
      const steps = (c.settings.steps as ActionInstance[]) ?? [];
      if (!steps.length) return c.showAlert();
      for (const s of steps) {
        if (s.type === 'sd.delay') await new Promise((r) => setTimeout(r, clamp(Number(s.settings.ms) || 0, 0, 60000)));
        else await c.runInstance(s);
      }
      c.showOk();
    },
  },
  {
    meta: {
      type: 'sd.delay', name: 'Delay', category: 'Hidden', icon: 'timer', color: '#94a3b8',
      description: 'Wait inside a multi action', controllers: [],
      fields: [{ key: 'ms', label: 'Milliseconds', type: 'number', min: 0, max: 60000, step: 50 }], defaults: { ms: 250 },
      elgato: ['com.elgato.streamdeck.multiactions.delay'],
    },
  },
  // ---------------------------------------------------------------------------------- Utility
  {
    meta: {
      type: 'util.toggle', name: 'Toggle', category: 'Utility', icon: 'toggle-left', color: '#2dd4bf',
      description: 'Two states: runs one command to turn on and another to turn off', controllers: ['key'],
      fields: [
        { key: 'onCommand', label: 'Command when turning on', type: 'textarea' },
        { key: 'offCommand', label: 'Command when turning off', type: 'textarea' },
        { key: 'onTitle', label: 'Title when on', type: 'text' },
      ],
      defaults: { onCommand: '', offCommand: '', onTitle: 'On' },
    },
    async keyDown(c) {
      c.state.on = !c.state.on;
      c.refresh();
      const cmd = String((c.state.on ? c.settings.onCommand : c.settings.offCommand) || '').trim();
      if (cmd) {
        const r = await c.platform.run(cmd);
        if (r.code !== 0) c.showAlert();
      }
    },
    key(c) {
      return c.state.on
        ? { state: 1, icon: 'toggle-right', title: String(c.settings.onTitle || '') || undefined }
        : { state: 0, icon: 'toggle-left' };
    },
  },
  {
    meta: {
      type: 'util.counter', name: 'Counter', category: 'Utility', icon: 'hash', color: '#f87171',
      description: 'Press to count up, hold to reset. On a dial: turn to change, press to reset.', controllers: ['key', 'dial'],
      fields: [{ key: 'step', label: 'Step', type: 'number', min: 1, max: 1000, step: 1 }], defaults: { step: 1 },
    },
    keyDown(c) {
      c.state.pressedAt = Date.now();
    },
    keyUp(c, held) {
      if (held < 500) {
        c.state.n = (c.state.n ?? 0) + (Number(c.settings.step) || 1);
        c.refresh();
      }
    },
    longPress(c) {
      c.state.n = 0;
      c.refresh();
      c.showOk();
    },
    dialRotate(c, t) {
      c.state.n = (c.state.n ?? 0) + t * (Number(c.settings.step) || 1);
      c.refresh();
    },
    dialDown(c) {
      c.state.n = 0;
      c.refresh();
    },
    key(c) {
      return { value: String(c.state.n ?? 0) };
    },
    touch(c) {
      return { layout: 'value', value: String(c.state.n ?? 0) };
    },
  },
  {
    meta: {
      type: 'util.clock', name: 'Clock', category: 'Utility', icon: 'clock', color: '#93c5fd',
      description: 'Live time and date', controllers: ['key', 'dial'],
      fields: [
        { key: 'format', label: 'Format', type: 'select', options: [{ value: '24', label: '24-hour' }, { value: '12', label: '12-hour' }] },
        { key: 'seconds', label: 'Show seconds', type: 'toggle' },
      ],
      defaults: { format: '24', seconds: false }, elgato: ['com.elgato.streamdeck.system.digitaltime'],
    },
    live: 1000,
    key(c) {
      return { value: clock(c.settings), title: dateLabel() };
    },
    touch(c) {
      return { layout: 'value', value: clock(c.settings), title: dateLabel() };
    },
  },
  {
    meta: {
      type: 'unsupported', name: 'Unsupported', category: 'Hidden', icon: 'puzzle', color: '#64748b',
      description: 'Imported action from a plugin this rev does not run', controllers: ['key', 'dial'],
      fields: [], defaults: {},
    },
    keyDown(c) {
      c.showAlert();
      c.log(`"${c.instance.settings.elgatoUUID ?? 'unknown'}" is a third-party plugin action and is not supported yet`);
    },
  },
];

const TEXT_TOKEN = /\{(date|time|weekday|isodate|datetime|clipboard)\}/;
/** Fill {date} {time} {weekday} {isodate} {datetime} {clipboard} in a Text snippet at press time. */
export async function expandTextTokens(text: string, platform: Platform, now = new Date()): Promise<string> {
  if (!/\{(date|time|weekday|isodate|datetime|clipboard)\}/.test(text)) return text;
  const pad = (n: number) => String(n).padStart(2, '0');
  const values: Record<string, () => Promise<string> | string> = {
    date: () => now.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }),
    time: () => now.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }),
    weekday: () => now.toLocaleDateString(undefined, { weekday: 'long' }),
    isodate: () => `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    datetime: () => now.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }),
    clipboard: async () => (platform.readClipboard ? await platform.readClipboard() : ''),
  };
  let out = '';
  let last = 0;
  for (const m of text.matchAll(/\{(date|time|weekday|isodate|datetime|clipboard)\}/g)) {
    out += text.slice(last, m.index) + (await values[m[1]!]!());
    last = m.index! + m[0].length;
  }
  return out + text.slice(last);
}

function clock(s: Record<string, any>): string {
  const d = new Date();
  let h = d.getHours();
  if (s.format === '12') h = h % 12 || 12;
  const m = String(d.getMinutes()).padStart(2, '0');
  const sec = s.seconds ? `:${String(d.getSeconds()).padStart(2, '0')}` : '';
  return `${s.format === '12' ? h : String(h).padStart(2, '0')}:${m}${sec}`;
}
function dateLabel(): string {
  return new Date().toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

export const ACTION_MAP = new Map(ACTIONS.map((a) => [a.meta.type, a]));
export const CATALOG = ACTIONS.map((a) => a.meta);

export function newInstance(type: string, id: string): ActionInstance {
  const def = ACTION_MAP.get(type);
  if (!def) throw new Error(`Unknown action ${type}`);
  return {
    id,
    type,
    settings: structuredClone(def.meta.defaults),
    // No icon: the action's default/live icon is used until the user picks one.
    appearance: { title: '' },
  };
}
