// Desktop Settings window (?view=settings). Toolbar tabs like a native macOS preferences window.
// Every control applies immediately; there is no Save button. Live service state comes from
// useAppState(), app-level preferences from useNativeState().

import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { AppState, DeviceSummary } from '../../../src/shared/types.ts';
import type { NativeCommand, NativeState, PrefKey } from '../../../src/shared/native.ts';
import { act, client, dismissToast, toast, useAppState, useToasts } from '../api.ts';
import { native, updateNativeState, useMenuCommand, useNativeState } from '../native.ts';
import { applyTheme, useTheme, type Theme } from '../theme.ts';
import { Icon } from '../components/Icon.tsx';
import './settings.css';

const TABS = [
  { id: 'general', label: 'General', icon: 'settings' },
  { id: 'devices', label: 'Devices', icon: 'layout-grid' },
  { id: 'permissions', label: 'Permissions', icon: 'shield-check' },
  { id: 'ai', label: 'AI', icon: 'sparkles' },
  { id: 'updates', label: 'Updates', icon: 'refresh-cw' },
  { id: 'about', label: 'About', icon: 'info' },
] as const;
type TabId = (typeof TABS)[number]['id'];

/** Mirrors DEFAULT_MODEL in electron/prefs.ts. */
const DEFAULT_MODEL = 'claude-sonnet-5-5';
const TAB_KEY = 'sdp.settings.tab';

function isTab(v: unknown): v is TabId {
  return TABS.some((t) => t.id === v);
}

// A tab request can arrive while the window is still loading, before the component's menu
// handlers are attached. Capture it at import time so the first paint shows the right tab.
let earlyTab: TabId | null = null;
native?.onMenu((c) => { const t = c.startsWith('settings.') ? c.slice('settings.'.length) : null; if (isTab(t)) earlyTab = t; });

function initialTab(): TabId {
  if (earlyTab) return earlyTab;
  try {
    const t = localStorage.getItem(TAB_KEY);
    if (isTab(t)) return t;
  } catch { /* storage unavailable */ }
  return 'general';
}

/** IPC errors arrive wrapped ("Error invoking remote method ..."); show only the readable part. */
function readable(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/, '') || 'Something went wrong. Try again.';
}

async function nativeCall<T>(fn: (n: NonNullable<typeof native>) => Promise<T>): Promise<T | undefined> {
  if (!native) return undefined;
  try {
    return await fn(native);
  } catch (e) {
    toast(readable(e), 'error');
    return undefined;
  }
}

async function setPref(key: PrefKey, value: unknown): Promise<boolean> {
  const next = await nativeCall((n) => n.setPref(key, value));
  if (next) updateNativeState(next);
  return !!next;
}

function command<T = unknown>(name: NativeCommand, arg?: unknown): Promise<T | undefined> {
  return nativeCall((n) => n.command<T>(name, arg));
}

// ---- window ----------------------------------------------------------------------------------

export function SettingsView() {
  const [tab, setTabState] = useState<TabId>(initialTab);
  const { state } = useAppState();
  const ns = useNativeState();
  const tabRefs = useRef(new Map<TabId, HTMLButtonElement>());

  const setTab = useCallback((t: TabId, focus = false) => {
    setTabState(t);
    try { localStorage.setItem(TAB_KEY, t); } catch { /* per-window convenience only */ }
    if (focus) tabRefs.current.get(t)?.focus();
  }, []);

  // The main process pre-selects a tab with `settings.<tab>` (e.g. from the menu bar extra).
  for (const t of TABS) {
    // TABS is constant, so these hooks always run in the same order.
    useMenuCommand(`settings.${t.id}`, useCallback(() => setTab(t.id), [setTab]));
  }

  useEffect(() => { if (earlyTab) setTab(earlyTab); }, [setTab]);

  const label = TABS.find((t) => t.id === tab)!.label;
  useEffect(() => { document.title = label; }, [label]);

  const onTabKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = TABS.findIndex((t) => t.id === tab);
    let next = -1;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (i + 1) % TABS.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (i - 1 + TABS.length) % TABS.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = TABS.length - 1;
    if (next < 0) return;
    e.preventDefault();
    setTab(TABS[next].id, true);
  };

  return (
    <div className="sv">
      <header className="sv-toolbar">
        <div className="sv-tabs" role="tablist" aria-label="Settings" onKeyDown={onTabKey}>
          {TABS.map((t) => (
            <button
              key={t.id}
              ref={(el) => { if (el) tabRefs.current.set(t.id, el); else tabRefs.current.delete(t.id); }}
              id={`sv-tab-${t.id}`}
              role="tab"
              aria-selected={tab === t.id}
              aria-controls="sv-panel"
              tabIndex={tab === t.id ? 0 : -1}
              className={`sv-tab${tab === t.id ? ' on' : ''}`}
              onClick={() => setTab(t.id)}
            >
              <Icon name={t.icon} size={22} />
              <span>{t.label}</span>
            </button>
          ))}
        </div>
      </header>
      <main id="sv-panel" className="sv-panel" role="tabpanel" aria-labelledby={`sv-tab-${tab}`} key={tab}>
        {tab === 'general' && <General state={state} ns={ns} />}
        {tab === 'devices' && <Devices state={state} ns={ns} />}
        {tab === 'permissions' && <Permissions state={state} />}
        {tab === 'ai' && <AI ns={ns} />}
        {tab === 'updates' && <Updates ns={ns} />}
        {tab === 'about' && <About ns={ns} />}
      </main>
      <Toasts />
    </div>
  );
}

function Toasts() {
  const toasts = useToasts();
  return (
    <div className="toasts sv-toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          <span>{t.msg}</span>
          {t.action ? <button className="toast-action" onClick={() => { dismissToast(t.id); void t.action!.run(); }}>{t.action.label}</button> : null}
        </div>
      ))}
    </div>
  );
}

// ---- building blocks ---------------------------------------------------------------------------

function Group({ title, footer, children }: { title?: string; footer?: ReactNode; children: ReactNode }) {
  const id = useId();
  return (
    <section className="sv-group" aria-labelledby={title ? id : undefined}>
      {title ? <h2 id={id} className="sv-group-title">{title}</h2> : null}
      <div className="sv-rows">{children}</div>
      {footer ? <p className="sv-group-footer">{footer}</p> : null}
    </section>
  );
}

interface A11y { 'aria-labelledby': string; 'aria-describedby'?: string }

function Row({ label, help, children, stack, icon }: {
  label: ReactNode;
  help?: ReactNode;
  icon?: ReactNode;
  /** Puts the control under the label (sliders, long fields). */
  stack?: boolean;
  children?: ReactNode | ((a11y: A11y) => ReactNode);
}) {
  const id = useId();
  const a11y: A11y = { 'aria-labelledby': `${id}-l`, ...(help ? { 'aria-describedby': `${id}-h` } : {}) };
  return (
    <div className={`sv-row${stack ? ' stack' : ''}`}>
      {icon ? <div className="sv-row-icon">{icon}</div> : null}
      <div className="sv-row-text">
        <div id={`${id}-l`} className="sv-label">{label}</div>
        {help ? <div id={`${id}-h`} className="sv-help">{help}</div> : null}
      </div>
      {children !== undefined ? <div className="sv-control">{typeof children === 'function' ? children(a11y) : children}</div> : null}
    </div>
  );
}

function Switch({ checked, onChange, disabled, ...a11y }: { checked: boolean; onChange(v: boolean): void; disabled?: boolean } & Partial<A11y>) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      className={`sv-switch${checked ? ' on' : ''}`}
      onClick={() => onChange(!checked)}
      {...a11y}
    >
      <span className="sv-switch-knob" />
    </button>
  );
}

/** A switch bound to an app preference, flipped optimistically so it never lags the click. */
function PrefSwitch({ pref, value, a11y }: { pref: 'openAtLogin' | 'showInMenuBar' | 'checkForUpdates'; value: boolean | undefined; a11y: A11y }) {
  const [pending, setPending] = useState<boolean | null>(null);
  const shown = pending ?? value ?? false;
  return (
    <Switch
      {...a11y}
      checked={shown}
      disabled={value === undefined}
      onChange={async (v) => { setPending(v); await setPref(pref, v); setPending(null); }}
    />
  );
}

/** A slider that previews instantly and sends at most one change per `ms` while dragging. */
function Slider({ value, min, max, step = 1, onSend, a11y, format = (v) => `${v}%` }: {
  value: number; min: number; max: number; step?: number; onSend(v: number): void; a11y: A11y; format?(v: number): string;
}) {
  const [draft, setDraft] = useState<number | null>(null);
  const last = useRef(0);
  const trailing = useRef<ReturnType<typeof setTimeout> | null>(null);
  const release = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ms = 80;
  useEffect(() => () => { if (trailing.current) clearTimeout(trailing.current); if (release.current) clearTimeout(release.current); }, []);

  const change = (v: number) => {
    setDraft(v);
    if (release.current) clearTimeout(release.current);
    if (trailing.current) clearTimeout(trailing.current);
    const wait = ms - (Date.now() - last.current);
    const send = () => { last.current = Date.now(); trailing.current = null; onSend(v); };
    if (wait <= 0) send();
    else trailing.current = setTimeout(send, wait);
  };
  // Keep the dragged value on screen until the live state has caught up.
  const settle = () => {
    if (release.current) clearTimeout(release.current);
    release.current = setTimeout(() => setDraft(null), 700);
  };
  const shown = draft ?? value;
  return (
    <div className="sv-slider">
      <Icon name="sun-dim" size={14} />
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={shown}
        aria-valuetext={format(shown)}
        onChange={(e) => change(Number(e.target.value))}
        onPointerUp={settle}
        onKeyUp={settle}
        onBlur={settle}
        {...a11y}
      />
      <Icon name="sun" size={16} />
      <output className="sv-slider-value">{format(shown)}</output>
    </div>
  );
}

function Starting() {
  return (
    <div className="sv-empty" role="status">
      <span className="sv-spinner" aria-hidden />
      <p>Starting…</p>
    </div>
  );
}

function Pane({ title, intro, children }: { title: string; intro?: ReactNode; children: ReactNode }) {
  return (
    <div className="sv-pane">
      <h1 className="sr">{title}</h1>
      {intro ? <p className="sv-intro">{intro}</p> : null}
      {children}
    </div>
  );
}

// ---- General -----------------------------------------------------------------------------------

function General({ state, ns }: { state: AppState | null; ns: NativeState | null }) {
  const theme = useTheme();
  const exec = state?.config.settings.executeActions;
  const [execPending, setExecPending] = useState<boolean | null>(null);
  const missing = state?.platform.permissions.filter((p) => p.ok === false) ?? [];

  const choose = (t: Theme) => applyTheme(t);
  const themes: { id: Theme; label: string }[] = [
    { id: 'system', label: 'Auto' },
    { id: 'light', label: 'Light' },
    { id: 'dark', label: 'Dark' },
  ];
  const onThemeKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = themes.findIndex((t) => t.id === theme);
    const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const next = themes[(i + d + themes.length) % themes.length].id;
    choose(next);
    (e.currentTarget.querySelector(`[data-theme-id="${next}"]`) as HTMLElement | null)?.focus();
  };

  return (
    <Pane title="General">
      <Group>
        <Row label="Open at login" help="StreamDeckPlus starts quietly in the menu bar when you log in.">
          {(a11y) => <PrefSwitch pref="openAtLogin" value={ns?.prefs.openAtLogin} a11y={a11y} />}
        </Row>
        <Row
          label="Show in menu bar"
          help={ns && !ns.prefs.showInMenuBar ? 'StreamDeckPlus stays in the Dock so you can always reach it.' : 'Switch profiles and brightness from the menu bar.'}
        >
          {(a11y) => <PrefSwitch pref="showInMenuBar" value={ns?.prefs.showInMenuBar} a11y={a11y} />}
        </Row>
      </Group>

      <Group>
        <Row
          label="Perform Mac actions"
          help={
            <>
              When off, keys show what they would do without controlling your Mac.
              {exec && missing.length ? <span className="sv-help-warn"> Some keys need permission first — see Permissions.</span> : null}
            </>
          }
        >
          {(a11y) => exec === undefined
            ? <span className="sv-muted">Starting…</span>
            : (
              <Switch
                {...a11y}
                checked={execPending ?? exec}
                onChange={async (v) => {
                  setExecPending(v);
                  await act('settings.update', { patch: { executeActions: v } });
                  setExecPending(null);
                }}
              />
            )}
        </Row>
      </Group>

      <Group>
        <Row label="Appearance" stack>
          {(a11y) => (
            <div className="sv-appearance" role="radiogroup" {...a11y} onKeyDown={onThemeKey}>
              {themes.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="radio"
                  data-theme-id={t.id}
                  aria-checked={theme === t.id}
                  tabIndex={theme === t.id ? 0 : -1}
                  className={`sv-theme${theme === t.id ? ' on' : ''}`}
                  onClick={() => choose(t.id)}
                >
                  <span className={`sv-theme-preview ${t.id}`} aria-hidden>
                    <span className="bar" /><span className="keys"><i /><i /><i /></span>
                  </span>
                  <span className="sv-theme-label">{t.label}</span>
                </button>
              ))}
            </div>
          )}
        </Row>
      </Group>
    </Pane>
  );
}

// ---- Devices -----------------------------------------------------------------------------------

const SLEEP_OPTIONS = [
  { seconds: 0, label: 'Never' },
  { seconds: 60, label: '1 minute' },
  { seconds: 300, label: '5 minutes' },
  { seconds: 600, label: '10 minutes' },
  { seconds: 1800, label: '30 minutes' },
];

function sleepLabel(seconds: number) {
  if (seconds % 60 === 0) return `${seconds / 60} minute${seconds === 60 ? '' : 's'}`;
  return `${seconds} seconds`;
}

function Devices({ state, ns }: { state: AppState | null; ns: NativeState | null }) {
  if (!state) return <Pane title="Devices"><Starting /></Pane>;
  const deck: DeviceSummary | undefined = state.devices.find((d) => d.kind === 'usb') ?? state.devices[0];
  const s = state.config.settings;

  return (
    <Pane title="Devices">
      {ns?.elgato.running ? <ElgatoRow name={ns.elgato.name} reopened={ns.elgato.reopened} /> : null}

      {state.platform.hidError && !deck ? (
        <div className="sv-callout bad" role="alert">
          <Icon name="triangle-alert" size={18} />
          <div>
            <strong>Device support didn't load.</strong>
            <p>Reinstall StreamDeckPlus, then open it again.</p>
          </div>
        </div>
      ) : null}

      {deck ? <DeckSettings deck={deck} /> : (
        <div className="sv-empty deck">
          <span className="sv-deck-glyph" aria-hidden><i /><i /><i /><i /><i /><i /></span>
          <p className="sv-empty-title">Plug in your Stream Deck.</p>
          <p className="sv-muted">It shows up here as soon as it's connected. To try the app without one, choose Device › Simulators.</p>
        </div>
      )}

      <Group title="All decks">
        <Row label="Press feedback" help="Keys shrink slightly while you hold them.">
          {(a11y) => <Switch {...a11y} checked={s.pressFeedback} onChange={(v) => void act('settings.update', { patch: { pressFeedback: v } })} />}
        </Row>
        <Row label="Brightness when a deck connects" stack>
          {(a11y) => (
            <Slider
              a11y={a11y}
              value={s.defaultBrightness}
              min={10}
              max={100}
              step={5}
              onSend={(v) => void act('settings.update', { patch: { defaultBrightness: v } })}
            />
          )}
        </Row>
      </Group>
    </Pane>
  );
}

function ElgatoRow({ name, reopened }: { name?: string; reopened?: boolean }) {
  const [busy, setBusy] = useState(false);
  const app = name || 'Elgato Stream Deck';
  return (
    <div className="sv-callout warn" role="status">
      <Icon name="circle-alert" size={18} />
      <div>
        <strong>{reopened ? 'Stream Deck reopened.' : `${app} is using your deck.`}</strong>
        <p>{reopened ? `Turn off Open at Login in ${app}, then try again.` : 'Quit it to let StreamDeckPlus connect.'}</p>
      </div>
      <button
        className="sv-btn"
        disabled={busy}
        onClick={async () => { setBusy(true); await command('elgato.quit'); setBusy(false); }}
      >
        {busy ? 'Quitting…' : 'Quit It and Connect'}
      </button>
    </div>
  );
}

function DeckSettings({ deck }: { deck: DeviceSummary }) {
  const custom = !SLEEP_OPTIONS.some((o) => o.seconds === deck.sleepDelay);
  const detail = deck.kind === 'sim' ? 'Simulated deck' : [deck.serial && `Serial ${deck.serial}`, deck.firmware && `Firmware ${deck.firmware}`].filter(Boolean).join(' · ');
  return (
    <Group>
      <Row
        icon={<span className="sv-deck-glyph small" aria-hidden><i /><i /><i /><i /><i /><i /></span>}
        label={<span className="sv-deck-name">{deck.modelName}</span>}
        help={detail || 'Connected'}
      >
        <span className={`sv-status ${deck.kind === 'usb' ? 'ok' : ''}`}>{deck.kind === 'usb' ? 'Connected' : 'Simulator'}</span>
      </Row>
      <Row label="Brightness" stack>
        {(a11y) => (
          <Slider
            a11y={a11y}
            value={deck.brightness}
            min={0}
            max={100}
            onSend={(v) => void act('devices.setBrightness', { deviceId: deck.id, value: v })}
          />
        )}
      </Row>
      <Row label="Sleep after" help="The keys go dark when the deck hasn't been used for this long.">
        {(a11y) => (
          <select
            className="sv-select"
            value={deck.sleepDelay}
            onChange={(e) => void act('devices.setSleepDelay', { deviceId: deck.id, seconds: Number(e.target.value) })}
            {...a11y}
          >
            {SLEEP_OPTIONS.map((o) => <option key={o.seconds} value={o.seconds}>{o.label}</option>)}
            {custom ? <option value={deck.sleepDelay}>{sleepLabel(deck.sleepDelay)}</option> : null}
          </select>
        )}
      </Row>
    </Group>
  );
}

// ---- Permissions -------------------------------------------------------------------------------

/** True while this window has focus; permission polling runs only then. */
function useWindowFocus() {
  const [focused, setFocused] = useState(() => document.hasFocus());
  useEffect(() => {
    const on = () => setFocused(true);
    const off = () => setFocused(false);
    window.addEventListener('focus', on);
    window.addEventListener('blur', off);
    return () => { window.removeEventListener('focus', on); window.removeEventListener('blur', off); };
  }, []);
  return focused;
}

function Permissions({ state }: { state: AppState | null }) {
  const focused = useWindowFocus();
  const [checking, setChecking] = useState(false);
  const asked = useRef(false); // see openPane below
  const ready = !!state;

  useEffect(() => {
    if (!focused || !ready) return;
    let stopped = false;
    const poll = () => { if (!stopped && client.connected) client.rpc('platform.permissions', { prompt: false }).catch(() => {}); };
    poll();
    const timer = setInterval(poll, 1000);
    return () => { stopped = true; clearInterval(timer); };
  }, [focused, ready]);

  if (!state) return <Pane title="Permissions"><Starting /></Pane>;
  const perms = state.platform.permissions ?? [];
  const allOk = perms.length > 0 && perms.every((p) => p.ok);

  const checkAgain = async () => {
    setChecking(true);
    const r = await act<{ ok: boolean | null }[]>('platform.permissions', { prompt: true });
    setChecking(false);
    if (r && r.length && r.every((p) => p.ok)) toast('StreamDeckPlus has the access it needs.');
  };

  if (!state.platform.canExecute || !perms.length) {
    return (
      <Pane title="Permissions">
        <div className="sv-empty">
          <Icon name="shield-check" size={28} />
          <p className="sv-empty-title">Nothing to allow here.</p>
          <p className="sv-muted">Keys that control your Mac aren't available on this computer.</p>
        </div>
      </Pane>
    );
  }

  // The first click asks macOS once (that is what lists StreamDeckPlus under Automation), then opens the pane.
  const openPane = async (id: string) => {
    if (!asked.current) { asked.current = true; await act('platform.permissions', { prompt: true }); }
    await command('permissions.open', id);
  };
  return (
    <Pane
      title="Permissions"
      intro={allOk
        ? 'StreamDeckPlus can press keys and control apps for you.'
        : 'Let StreamDeckPlus press keys and control apps for you. Volume, Open and Website keys work without this.'}
    >
      <Group
        footer={
          <>
            After you change access in System Settings, this page updates on its own.
            {!state.config.settings.executeActions ? ' Mac actions are off in General, so keys only show what they would do.' : ''}
          </>
        }
      >
        {perms.map((p) => (
          <Row
            key={p.id}
            icon={<PermIcon ok={p.ok} />}
            label={p.label}
            help={<>{p.detail}<span className="sr"> — {p.ok ? 'Allowed' : p.ok === false ? 'Not allowed' : 'Not checked yet'}</span></>}
          >
            {p.ok
              ? <span className="sv-status ok">Allowed</span>
              : <button className="sv-btn" onClick={() => void openPane(p.id)}>Open System Settings</button>}
          </Row>
        ))}
      </Group>
      <div className="sv-actions">
        <button className="sv-btn" disabled={checking} onClick={checkAgain}>{checking ? 'Checking…' : 'Check Again'}</button>
      </div>
    </Pane>
  );
}

function PermIcon({ ok }: { ok: boolean | null }) {
  return (
    <span className={`sv-perm-icon ${ok ? 'ok' : ok === false ? 'no' : 'unk'}`} aria-hidden>
      <Icon name={ok ? 'check' : ok === false ? 'x' : 'circle-dashed'} size={13} />
    </span>
  );
}

// ---- AI ----------------------------------------------------------------------------------------

function AI({ ns }: { ns: NativeState | null }) {
  const [replacing, setReplacing] = useState(false);
  const [key, setKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [test, setTest] = useState<{ ok: boolean; message: string } | 'running' | null>(null);
  const keyInput = useRef<HTMLInputElement>(null);
  const hasKey = !!ns?.ai.hasKey;
  const secure = ns?.ai.secureStorage ?? true;
  const editing = !hasKey || replacing;

  useEffect(() => { if (replacing) keyInput.current?.focus(); }, [replacing]);

  const save = async () => {
    const value = key.trim();
    if (!value || saving) return;
    setSaving(true);
    const next = await nativeCall((n) => n.setApiKey(value));
    setSaving(false);
    if (!next) return;
    updateNativeState(next);
    setKey('');
    setReplacing(false);
    setTest(null);
    toast('Key saved to your Keychain.');
  };

  const remove = async () => {
    if (!window.confirm('Remove your API key from this Mac?')) return;
    const next = await nativeCall((n) => n.setApiKey(null));
    if (!next) return;
    updateNativeState(next);
    setReplacing(false);
    setTest(null);
  };

  const runTest = async () => {
    setTest('running');
    const r = await command<{ ok: boolean; message: string }>('ai.test');
    setTest(r ?? null);
  };

  return (
    <Pane title="AI" intro="Describe a key in your own words and StreamDeckPlus sets it up. This uses your Anthropic API key.">
      {!secure ? (
        <div className="sv-callout warn" role="status">
          <Icon name="circle-alert" size={18} />
          <div>
            <strong>Your key can't be stored right now.</strong>
            <p>Your Mac's Keychain isn't available. Log out and back in, then try again.</p>
          </div>
        </div>
      ) : null}

      <Group footer="Stored in your Mac's Keychain. Sent only to api.anthropic.com when you ask.">
        {editing ? (
          <Row label="API key" help={hasKey ? 'The new key replaces the one in your Keychain.' : 'Create one at console.anthropic.com.'} stack>
            {(a11y) => (
              <form
                className="sv-inline"
                onSubmit={(e) => { e.preventDefault(); void save(); }}
              >
                <input
                  ref={keyInput}
                  className="sv-input mono"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="sk-ant-…"
                  value={key}
                  disabled={!secure || !ns}
                  onChange={(e) => setKey(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Escape' && replacing) { e.preventDefault(); setKey(''); setReplacing(false); } }}
                  {...a11y}
                />
                {replacing ? <button type="button" className="sv-btn" onClick={() => { setKey(''); setReplacing(false); }}>Cancel</button> : null}
                <button type="submit" className="sv-btn primary" disabled={!key.trim() || saving || !secure}>
                  {saving ? 'Saving…' : 'Save Key'}
                </button>
              </form>
            )}
          </Row>
        ) : (
          <Row
            icon={<span className="sv-perm-icon ok" aria-hidden><Icon name="key-round" size={13} /></span>}
            label="API key"
            help="Stored in your Mac's Keychain"
          >
            <div className="sv-inline">
              <button className="sv-btn" onClick={() => setReplacing(true)} disabled={!secure}>Replace</button>
              <button className="sv-btn" onClick={remove}>Remove</button>
            </div>
          </Row>
        )}
        <ModelRow model={ns?.ai.model} />
        <Row
          label="Test connection"
          help={
            test === 'running' ? 'Sending a short test message…'
              : test ? <span className={test.ok ? 'sv-help-ok' : 'sv-help-bad'} role="status">
                  <Icon name={test.ok ? 'circle-check' : 'circle-x'} size={13} /> {test.message}
                </span>
              : hasKey ? 'Checks that your key and model work.' : 'Add a key to test it.'
          }
        >
          <button className="sv-btn" disabled={!hasKey || test === 'running'} onClick={runTest}>
            {test === 'running' ? 'Testing…' : 'Test'}
          </button>
        </Row>
      </Group>
    </Pane>
  );
}

function ModelRow({ model }: { model: string | undefined }) {
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? model ?? '';
  const commit = async () => {
    if (draft === null) return;
    const next = draft.trim() || DEFAULT_MODEL;
    if (next === model) { setDraft(null); return; }
    const ok = await setPref('model', next);
    if (ok) setDraft(null);
  };
  return (
    <Row
      label="Model"
      help={model && model !== DEFAULT_MODEL
        ? <>Default is {DEFAULT_MODEL}. <button className="sv-link" onClick={() => { setDraft(null); void setPref('model', DEFAULT_MODEL); }}>Use Default</button></>
        : 'The default works well for setting up keys.'}
    >
      {(a11y) => (
        <input
          className="sv-input mono model"
          value={value}
          placeholder={DEFAULT_MODEL}
          spellCheck={false}
          autoComplete="off"
          disabled={model === undefined}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => void commit()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); void commit(); }
            if (e.key === 'Escape') { e.preventDefault(); setDraft(null); }
          }}
          {...a11y}
        />
      )}
    </Row>
  );
}

// ---- Updates -----------------------------------------------------------------------------------

function Updates({ ns }: { ns: NativeState | null }) {
  const u = ns?.update ?? { state: 'idle' as const };
  const busy = u.state === 'checking' || u.state === 'downloading';

  let icon = 'refresh-cw';
  let tone = '';
  let title = 'Check for a new version anytime.';
  let detail: ReactNode = null;
  switch (u.state) {
    case 'unavailable': icon = 'circle-minus'; title = 'Updates aren’t available for this copy.'; detail = u.reason; break;
    case 'checking': icon = 'loader-circle'; tone = 'spin'; title = 'Checking for updates…'; break;
    case 'current': icon = 'circle-check'; tone = 'ok'; title = 'StreamDeckPlus is up to date.'; detail = `Version ${u.version} is the latest.`; break;
    case 'downloading': icon = 'download'; title = `Downloading version ${u.version}…`; detail = <progress className="sv-progress" max={100} value={u.percent} aria-label="Download progress" />; break;
    case 'ready': icon = 'circle-check'; tone = 'ok'; title = `Version ${u.version} is ready.`; detail = 'Restart StreamDeckPlus to finish updating. Your decks reconnect on their own.'; break;
    case 'error': icon = 'circle-alert'; tone = 'bad'; title = 'The update check didn’t finish.'; detail = u.message; break;
  }

  return (
    <Pane title="Updates">
      <Group>
        <Row label="Current version" help={ns?.packaged === false ? 'Development build' : undefined}>
          <span className="sv-value">{ns?.version ?? '—'}</span>
        </Row>
        <div className="sv-row sv-update" role="status" aria-live="polite">
          <div className={`sv-row-icon sv-update-icon ${tone}`}><Icon name={icon} size={20} /></div>
          <div className="sv-row-text">
            <div className="sv-label">{title}</div>
            {detail ? <div className="sv-help">{detail}</div> : null}
          </div>
          <div className="sv-control">
            {u.state === 'ready'
              ? <button className="sv-btn primary" onClick={() => void command('update.install')}>Restart to Update</button>
              : <button className="sv-btn" disabled={busy || u.state === 'unavailable' || !ns} onClick={() => void command('update.check')}>
                  {u.state === 'checking' ? 'Checking…' : 'Check Now'}
                </button>}
          </div>
        </div>
      </Group>
      <Group>
        <Row
          label="Check automatically"
          help="Looks for a new version every few hours and downloads it in the background. Only the version number is asked for; nothing about your decks or keys is sent."
        >
          {(a11y) => <PrefSwitch pref="checkForUpdates" value={ns ? ns.prefs.checkForUpdates : undefined} a11y={a11y} />}
        </Row>
      </Group>
    </Pane>
  );
}

// ---- About -------------------------------------------------------------------------------------

function About({ ns }: { ns: NativeState | null }) {
  const copy = async () => {
    const ok = await command('diagnostics.copy');
    if (ok !== undefined) toast('Diagnostics copied. Paste them into your report.');
  };
  return (
    <Pane title="About">
      <div className="sv-about">
        <span className="sv-app-icon" aria-hidden><span className="sv-deck-glyph"><i /><i /><i /><i /><i /><i /></span></span>
        <h2 className="sv-app-name">StreamDeckPlus</h2>
        <p className="sv-muted">Version {ns?.version ?? '—'}{ns?.packaged === false ? ' (development)' : ''}</p>
        <p className="sv-about-desc">Set up and use your Stream Deck Neo and Stream Deck + without the Stream Deck app.</p>
      </div>
      <Group>
        <Row label="Data folder" help="Your profiles, buttons and images.">
          <button className="sv-btn" onClick={() => void command('data.show')}><Icon name="folder-open" size={14} /> Open Data Folder</button>
        </Row>
        <Row label="Logs" help="Helpful when something isn't working.">
          <button className="sv-btn" onClick={() => void command('logs.show')}><Icon name="file-text" size={14} /> Show Logs</button>
        </Row>
        <Row label="Diagnostics" help="A short summary of your setup to include when you report a problem. It has no keys or personal files.">
          <button className="sv-btn" onClick={copy}><Icon name="clipboard-copy" size={14} /> Copy Diagnostics</button>
        </Row>
        <Row label="Open-source licenses" help="Software StreamDeckPlus is built with.">
          <button className="sv-btn" onClick={() => void command('licenses.show')}><Icon name="scale" size={14} /> Licenses</button>
        </Row>
      </Group>
      <p className="sv-copyright">© Reading Plus AI LLC · MIT License</p>
    </Pane>
  );
}
