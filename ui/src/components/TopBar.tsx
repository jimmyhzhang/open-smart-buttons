import { useEffect, useRef, useState } from 'react';
import type { AppState, DeviceSummary, Profile } from '../../../src/shared/types.ts';
import { act, toast } from '../api.ts';
import { applyTheme, useTheme, type Theme } from '../theme.ts';
import { Icon } from './Icon.tsx';
import { PermissionBanner } from './PermissionBanner.tsx';
import { isNative, native, useMenuCommand } from '../native.ts';
import type { Mode } from './DeviceView.tsx';

function Popover({ open, onClose, children, align = 'left' }: { open: boolean; onClose(): void; children: React.ReactNode; align?: 'left' | 'right' }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => !ref.current?.parentElement?.contains(e.target as Node) && onClose();
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('mousedown', h);
    window.addEventListener('keydown', k);
    return () => {
      window.removeEventListener('mousedown', h);
      window.removeEventListener('keydown', k);
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div ref={ref} className={`popover ${align}`}>
      {children}
    </div>
  );
}

interface Props {
  state: AppState;
  device: DeviceSummary | undefined;
  profile: Profile | undefined;
  mode: Mode;
  setMode(m: Mode): void;
  selectDevice(id: string): void;
  connected: boolean;
}

/** Profile and device actions shared by the TopBar menus and the app's menu bar. */
interface Actions {
  newProfile(): void;
  startRename(): void;
  importProfile(): void;
  exportProfile(): void;
  reconnect(): void;
  connecting: boolean;
}

export function TopBar(p: Props) {
  const [menu, setMenu] = useState<'device' | 'profile' | 'settings' | null>(null);
  /** The profile whose name is being edited inline in the profile chip. */
  const [renaming, setRenaming] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const settingsButton = useRef<HTMLButtonElement>(null);
  const profileChip = useRef<HTMLButtonElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const close = () => setMenu(null);
  const d = p.device;
  const profile = p.profile;

  const newProfile = async () => {
    if (!profile) return;
    close();
    const id = await act<string>('profiles.create', { name: 'Untitled Profile', modelId: profile.modelId });
    if (!id) return;
    if (d) await act('session.setProfile', { deviceId: d.id, profileId: id });
    setRenaming(id);
  };
  const startRename = () => {
    if (!profile) return;
    close();
    setRenaming(profile.id);
  };
  const finishRename = (name: string | null) => {
    const target = renaming && p.state.config.profiles.find((x) => x.id === renaming);
    setRenaming(null);
    const next = name?.trim();
    if (target && next && next !== target.name) void act('profiles.rename', { profileId: target.id, name: next });
    requestAnimationFrame(() => profileChip.current?.focus({ preventScroll: true }));
  };
  const importFile = async (f: File) => {
    close();
    const buf = new Uint8Array(await f.arrayBuffer());
    if (f.name.endsWith('.json')) {
      let data: unknown;
      try { data = JSON.parse(new TextDecoder().decode(buf)); }
      catch { toast("That file isn't a profile Open Smart Buttons can read.", 'error'); return; }
      const id = await act<string>('profiles.importJson', { data });
      if (id && d) await act('session.setProfile', { deviceId: d.id, profileId: id });
      return;
    }
    let bin = '';
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    const r = await act<{ profileId: string; warnings: string[] }>('profiles.importElgato', { base64: btoa(bin), name: f.name });
    if (!r) return;
    toast(r.warnings.length ? `Imported with ${r.warnings.length} note(s): ${r.warnings.slice(0, 2).join('; ')}` : 'Profile imported');
    if (d) await act('session.setProfile', { deviceId: d.id, profileId: r.profileId });
  };
  const importProfile = () => fileRef.current?.click();
  const exportProfile = () => {
    if (!profile) return;
    const blob = new Blob([JSON.stringify(profile, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${profile.name.replace(/[^\w -]+/g, '')}.osb.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
  };
  const reconnect = async () => {
    if (connecting) return;
    if (!d || d.kind !== 'usb') { toast('Plug in your Stream Deck, then try again.'); return; }
    setConnecting(true);
    try { const id = await act<string>('devices.reconnect', { deviceId: d.id }); if (id) { p.selectDevice(id); toast('Device reconnected'); } }
    finally { setConnecting(false); }
  };
  const actions: Actions = { newProfile: () => void newProfile(), startRename, importProfile, exportProfile, reconnect: () => void reconnect(), connecting };

  // The app's menu bar (File, Device). In the browser these never fire.
  useMenuCommand('profile.new', actions.newProfile);
  useMenuCommand('profile.import', importProfile);
  useMenuCommand('profile.export', exportProfile);
  useMenuCommand('device.reconnect', actions.reconnect);

  const openSettings = () => {
    if (native) void native.command('settings.open').catch(() => toast("Settings didn't open. Try again.", 'error'));
    else setMenu(menu === 'settings' ? null : 'settings');
  };

  useEffect(() => {
    // In the app, ⌘, belongs to the menu bar and opens the Settings window.
    if (isNative) return;
    const onSettingsShortcut = (event: KeyboardEvent) => {
      if (!event.metaKey || event.key !== ',' || document.querySelector('dialog[open]')) return;
      event.preventDefault();
      setMenu('settings');
      requestAnimationFrame(() => settingsButton.current?.parentElement?.querySelector<HTMLElement>('.popover button')?.focus());
    };
    window.addEventListener('keydown', onSettingsShortcut);
    return () => window.removeEventListener('keydown', onSettingsShortcut);
  }, []);

  return (
    <header className="topbar">
      {!isNative && (
        <div className="brand" aria-label="Open Smart Buttons">
          <svg viewBox="0 0 32 32" width="22" height="22" aria-hidden>
            <rect x="3" y="5" width="26" height="22" rx="5" fill="currentColor" opacity=".9" />
            <rect x="7" y="9" width="7" height="6" rx="1.5" fill="var(--signal)" />
            <rect x="18" y="9" width="7" height="6" rx="1.5" fill="var(--bg)" />
            <circle cx="10" cy="21" r="2.5" fill="var(--bg)" />
            <circle cx="22" cy="21" r="2.5" fill="var(--bg)" />
          </svg>
          <span>Open Smart Buttons</span>
        </div>
      )}

      <div className="menu-anchor">
        <button className="chip" onClick={() => setMenu(menu === 'device' ? null : 'device')} aria-expanded={menu === 'device'}>
          <span className={`led ${p.device ? (p.device.kind === 'usb' ? 'usb' : 'sim') : 'off'}`} />
          {p.device ? (
            <>
              {p.device.modelName}
              {p.device.kind === 'sim' && <span className="muted device-id">Simulator</span>}
            </>
          ) : (
            'No device'
          )}
          <Icon name="chevron-down" size={14} />
        </button>
        <Popover open={menu === 'device'} onClose={close}>
          <DeviceMenu {...p} {...actions} close={close} />
        </Popover>
      </div>

      {profile ? (
        <div className="menu-anchor">
          {renaming === profile.id ? (
            <RenameField key={profile.id} initial={profile.name} onDone={finishRename} />
          ) : (
            <button ref={profileChip} className="chip" onClick={() => setMenu(menu === 'profile' ? null : 'profile')} onDoubleClick={startRename} aria-expanded={menu === 'profile'} title="Double-click to rename">
              <Icon name="layout-grid" size={15} /> {profile.name}
              <Icon name="chevron-down" size={14} />
            </button>
          )}
          <Popover open={menu === 'profile'} onClose={close}>
            <ProfileMenu {...p} {...actions} close={close} />
          </Popover>
        </div>
      ) : null}
      <input ref={fileRef} id="profile-import" type="file" hidden accept=".streamDeckProfile,.json" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void importFile(f); }} />

      <div className="spacer" />
      {!p.connected && !isNative ? <span className="offline" role="status">Reconnecting…</span> : null}
      {!(p.device?.canExecute ?? p.state.platform.canExecute) ? (
        isNative ? (
          <span className={p.device?.kind === 'sim' ? 'dry dry-sim' : 'dry'} title={p.device?.kind === 'sim' ? 'Simulators never control your Mac. Keys show what they would do.' : 'Keys show what they would do. Turn on Perform Mac actions in Settings.'}>
            {p.device?.kind === 'sim' ? 'Dry run' : 'Mac actions off'}
          </span>
        ) : (
          <span className="dry" title={p.device?.kind === 'sim' ? 'Simulators always use Dry run.' : 'Actions are logged instead of performed. Change this in Settings.'}>
            Dry run
          </span>
        )
      ) : null}

      <div className="seg mode" role="radiogroup" aria-label="Interaction mode">
        <button role="radio" aria-checked={p.mode === 'edit'} className={p.mode === 'edit' ? 'on' : ''} onClick={() => p.setMode('edit')} title="Edit: select, drag and drop (E)">
          <Icon name="pencil" size={14} /> Edit
        </button>
        <button role="radio" aria-checked={p.mode === 'use'} className={p.mode === 'use' ? 'on' : ''} onClick={() => p.setMode('use')} title="Use: press keys, turn dials, touch the strip (U)">
          <Icon name="pointer" size={14} /> Use
        </button>
      </div>

      <div className="menu-anchor" onKeyDown={e => {
        if (e.key === 'Escape' && menu === 'settings') { e.stopPropagation(); close(); settingsButton.current?.focus(); }
      }}>
        <button ref={settingsButton} className="ghost icon-btn" aria-label="Settings" aria-expanded={isNative ? undefined : menu === 'settings'} aria-keyshortcuts="Meta+," title="Settings (⌘,)" onClick={openSettings}>
          <Icon name="settings" size={18} />
        </button>
        <Popover open={menu === 'settings'} onClose={close} align="right">
          <SettingsMenu state={p.state} />
        </Popover>
      </div>
    </header>
  );
}

function DeviceMenu(p: Props & Actions & { close(): void }) {
  const d = p.device;
  const { connecting, reconnect } = p;
  const sleepOpts = [0, 60, 300, 900, 1800, 3600];
  const simulate = async (modelId: 'plus' | 'neo') => {
    const id = await act<string>('sim.add', { modelId });
    if (id) { p.selectDevice(id); p.close(); }
  };
  return (
    <div className="menu device-menu">
      <h4>Connected</h4>
      {p.state.devices.map((x) => (
        <button key={x.id} className={`menu-item ${x.id === d?.id ? 'on' : ''}`} onClick={() => { p.selectDevice(x.id); p.close(); }}>
          <span className={`led ${x.kind}`} />
          <span className="grow">
            {x.modelName} <span className="muted">{x.kind === 'sim' ? 'Simulator' : x.serial}</span>
          </span>
          {x.id === d?.id ? <Icon name="check" size={14} /> : null}
        </button>
      ))}
      {p.state.discovered
        .filter((x) => x.kind === 'usb' && !x.deviceId)
        .map((x) => (
          <div key={x.path} className="menu-item static">
            <span className="led off" />
            <span className="grow">
              {x.modelName} <span className="muted">{x.serial}</span>
              {x.error ? <span className="err">{x.error}</span> : null}
              {!x.supported ? <span className="muted"> Not supported in this version</span> : null}
            </span>
            {x.supported ? (
              <button className="secondary small" onClick={() => act('devices.connect', { path: x.path })}>
                Connect
              </button>
            ) : null}
          </div>
        ))}
      {p.state.platform.hidError ? <p className="muted small pad-x">USB support couldn’t start. Restart Open Smart Buttons to try again.</p> : null}
      {connecting && <p role="status" className="muted small pad-x">Reconnecting your device…</p>}
      {d && <div className="menu-row connection-controls">
            {d.kind === 'sim' ? (
              <>
                <button className="secondary" onClick={() => act('sim.unplug', { deviceId: d.id })} title="Simulate pulling the USB cable">
                  <Icon name="unplug" size={14} /> Unplug
                </button>
              </>
            ) : (
              <>
                <button className="secondary" disabled={connecting} onClick={reconnect} title="Release this app’s connection, then reopen the device"><Icon name="refresh-cw" size={14}/>{connecting ? 'Reconnecting…' : 'Reconnect'}</button>
                <button className="ghost danger" disabled={connecting} onClick={() => act('devices.disconnect', { deviceId: d.id })}><Icon name="unplug" size={14}/> Disconnect</button>
              </>
            )}
      </div>}
      <details className="device-tools"><summary>Simulator and diagnostics</summary>
      <div className="menu-row">
        <button className="secondary" onClick={() => void simulate('plus')}>
          <Icon name="plus" size={14} /> Simulate +
        </button>
        <button className="secondary" onClick={() => void simulate('neo')}>
          <Icon name="plus" size={14} /> Simulate Neo
        </button>
        <button className="ghost" onClick={() => act('devices.scan').then(() => toast('Scanned for USB devices'))}>
          <Icon name="refresh-cw" size={14} /> Rescan
        </button>
      </div>
      </details>
      {d ? (
        <>
          <h4>This device</h4>
          <dl className="info">
            <dt>Model</dt>
            <dd>{d.modelName}</dd>
            <dt>Serial</dt>
            <dd>{d.serial || '—'}</dd>
            <dt>Firmware</dt>
            <dd>{d.firmware}</dd>
            <dt>Connection</dt>
            <dd>{d.kind === 'sim' ? (isNative ? 'Simulator' : 'HID simulator') : (isNative ? 'USB' : 'USB HID')}</dd>
            {d.sim ? (
              <>
                <dt>Traffic</dt>
                <dd>
                  {d.sim.stats.outputReports} out · {d.sim.stats.featureReports} feature · {d.sim.stats.inputReports} in
                </dd>
              </>
            ) : null}
          </dl>
          <label className="field">
            <span>Brightness {d.brightness}%</span>
            <input type="range" min={0} max={100} step={5} value={d.brightness} onChange={(e) => act('devices.setBrightness', { deviceId: d.id, value: Number(e.target.value) })} />
          </label>
          <label className="field">
            <span>Sleep after</span>
            <select value={d.sleepDelay} onChange={(e) => act('devices.setSleepDelay', { deviceId: d.id, seconds: Number(e.target.value) })}>
              {sleepOpts.map((s) => (
                <option key={s} value={s}>
                  {s === 0 ? 'Never' : s < 3600 ? `${s / 60} min` : '1 hour'}
                </option>
              ))}
            </select>
          </label>
          <div className="menu-row">
            <button className="secondary" onClick={() => act('devices.identify', { deviceId: d.id })}>
              <Icon name="scan-eye" size={14} /> Identify
            </button>
            <button className="secondary" onClick={() => act('devices.reset', { deviceId: d.id })} title="Shows the boot logo, then redraws">
              <Icon name="rotate-ccw" size={14} /> Reset
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}

function ProfileMenu(p: Props & Actions & { close(): void }) {
  const profile = p.profile!;
  const d = p.device;
  const mine = p.state.config.profiles.filter((x) => x.modelId === profile.modelId);
  return (
    <div className="menu">
      <h4>Profiles</h4>
      {mine.map((x) => (
        <button key={x.id} className={`menu-item ${x.id === profile.id ? 'on' : ''}`} onClick={() => {
          p.close();
          if (d && x.id !== profile.id) void act('session.setProfile', { deviceId: d.id, profileId: x.id });
        }}>
          <span className="grow">{x.name}</span>
          <span className="muted small">{x.pageOrder.length} {x.pageOrder.length === 1 ? 'page' : 'pages'}</span>
          {x.id === profile.id ? <Icon name="check" size={14} /> : null}
        </button>
      ))}
      <div className="menu-sep" />
      <button className="menu-item" onClick={p.newProfile}>
        <Icon name="plus" size={14} /> New profile
      </button>
      <button className="menu-item" onClick={p.startRename}>
        <Icon name="pencil" size={14} /> Rename
      </button>
      <button className="menu-item" onClick={async () => {
        const id = await act<string>('profiles.duplicate', { profileId: profile.id });
        if (id && d) await act('session.setProfile', { deviceId: d.id, profileId: id });
      }}>
        <Icon name="copy" size={14} /> Duplicate
      </button>
      <button className="menu-item" onClick={p.importProfile}>
        <Icon name="download" size={14} /> Import (.streamDeckProfile or .json)
      </button>
      <button className="menu-item" onClick={p.exportProfile}>
        <Icon name="upload" size={14} /> Export as JSON
      </button>
      <button className="menu-item danger" disabled={mine.length <= 1} onClick={() => confirm(`Delete profile “${profile.name}”?`) && act('profiles.delete', { profileId: profile.id })}>
        <Icon name="trash-2" size={14} /> Delete
      </button>
    </div>
  );
}

/** The profile chip turned into a text field. Enter or blur saves, Escape cancels. */
function RenameField({ initial, onDone }: { initial: string; onDone(name: string | null): void }) {
  const done = useRef(false);
  const finish = (name: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(name);
  };
  return (
    <input
      className="chip rename-field"
      autoFocus
      defaultValue={initial}
      maxLength={60}
      aria-label="Profile name"
      spellCheck={false}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={(e) => finish(e.currentTarget.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); finish(e.currentTarget.value); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(null); }
      }}
    />
  );
}

function SettingsMenu({ state }: { state: AppState }) {
  const s = state.config.settings;
  const theme = useTheme();
  const set = (patch: Record<string, unknown>) => act('settings.update', { patch });
  return (
    <div className="menu settings">
      <h4>Settings</h4>
      <PermissionBanner state={state} inSettings />
      <div className="field theme-field">
        <span>Appearance</span>
        <div className="seg" role="radiogroup" aria-label="Appearance">
          {(['system', 'light', 'dark'] as const).map((t) => (
            <button key={t} role="radio" aria-checked={theme === t} className={theme === t ? 'on' : ''} onClick={() => applyTheme(t)}>
              {t === 'system' ? 'Auto' : t === 'light' ? 'Light' : 'Dark'}
            </button>
          ))}
        </div>
      </div>
      <label className="check">
        <input type="checkbox" checked={s.executeActions} onChange={(e) => set({ executeActions: e.target.checked })} />
        <span>
          Perform actions from USB decks on this computer
          <small>When off, keys show what they would do in the activity drawer.</small>
        </span>
      </label>
      <label className="check">
        <input type="checkbox" checked={s.pressFeedback} onChange={(e) => set({ pressFeedback: e.target.checked })} />
        <span>
          Press feedback on keys
          <small>Keys shrink slightly while held.</small>
        </span>
      </label>
      <label className="check">
        <input type="checkbox" checked={s.swipeChangesPages} onChange={(e) => set({ swipeChangesPages: e.target.checked })} />
        <span>Swipe the touch strip to change pages</span>
      </label>
      <label className="check">
        <input type="checkbox" checked={s.autoSimulator} onChange={(e) => set({ autoSimulator: e.target.checked })} />
        <span>
          Start a simulator on launch
          <small>Takes effect next time the app starts.</small>
        </span>
      </label>
      <label className="field">
        <span>Brightness for new connections: {s.defaultBrightness}%</span>
        <input type="range" min={10} max={100} step={5} value={s.defaultBrightness} onChange={(e) => set({ defaultBrightness: Number(e.target.value) })} />
      </label>
      <p className="muted small">
        Running on {state.platform.os}. USB {state.platform.hidAvailable ? 'available' : 'unavailable'}.
      </p>
    </div>
  );
}
