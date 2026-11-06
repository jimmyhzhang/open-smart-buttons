import { useState } from 'react';
import type { AppState } from '../../../src/shared/types.ts';
import { act, toast } from '../api.ts';
import { Icon } from './Icon.tsx';
import { native } from '../native.ts';

/** In the app, permissions live in the Settings window; the app itself is what macOS asks about. */
const openPermissionSettings = () => void native?.command('settings.open', 'permissions').catch(() => toast("Settings didn't open. Try again.", 'error'));

/** Explains which macOS permissions are missing for key actions and lets the user grant them. */
export function PermissionBanner({ state, inSettings = false }: { state: AppState; inSettings?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [hidden, setHidden] = useState(false);
  const perms = state.platform.permissions ?? [];
  const missing = perms.filter((p) => p.ok === false);
  if (!state.platform.canExecute || !perms.length || hidden) return null;
  const unknown = perms.filter((p) => p.ok === null);
  if (!missing.length && (!inSettings || !unknown.length)) return null;
  const host = state.platform.host;

  const check = async (prompt: boolean) => {
    setBusy(true);
    const r = await act<{ ok: boolean | null }[]>('platform.permissions', { prompt });
    setBusy(false);
    if (r && r.every((p) => p.ok)) toast(`${host} has the permissions it needs`);
  };

  if (!inSettings) return (
    <details className="studio-permissions">
      <summary><Icon name="shield-alert" size={15}/> Some actions need macOS access</summary>
      <PermissionBanner state={state} inSettings />
    </details>
  );

  return (
    <div className={`perm-banner ${missing.length ? 'bad' : 'pending'}`} role="status">
      <Icon name={missing.length ? 'shield-alert' : 'shield-question'} size={18} />
      <div className="perm-text">
        <strong>
          {missing.length
            ? `Some keys can't control your Mac yet. macOS needs to allow ${host}.`
            : `Check that ${host} is allowed to control your Mac.`}
        </strong>
        <ul>
          {perms.map((p) => (
            <li key={p.id} className={p.ok ? 'ok' : p.ok === false ? 'no' : 'unk'}>
              <Icon name={p.ok ? 'check' : p.ok === false ? 'x' : 'circle-help'} size={13} /> <b>{p.label}</b> — {p.detail}
              {p.ok === false ? (
                <button className="link" onClick={() => act('platform.openSettings', { id: p.id })}>
                  Open settings
                </button>
              ) : null}
            </li>
          ))}
        </ul>
        {native
          ? <p className="muted small">Volume, Open and Website work without it. To allow the rest, open Settings ▸ Permissions.</p>
          : <p className="muted small">StreamDeckPlus runs inside {host}, so macOS asks for {host}'s permission. Volume, Open and Website work without it. After changing macOS settings, press Check again. If access is still blocked, restart the app from the same host.</p>}
      </div>
      <div className="perm-actions">
        {native ? (
          <button className="primary" onClick={openPermissionSettings}>
            Open Settings ▸ Permissions
          </button>
        ) : (
          <button className="primary" disabled={busy} onClick={() => check(true)}>
            {busy ? 'Checking…' : 'Grant access'}
          </button>
        )}
        <button className="secondary" disabled={busy} onClick={() => check(false)}>
          Check again
        </button>
        <button className="ghost icon-btn" aria-label="Hide permission details" onClick={() => setHidden(true)}>
          <Icon name="x" size={14} />
        </button>
      </div>
    </div>
  );
}
