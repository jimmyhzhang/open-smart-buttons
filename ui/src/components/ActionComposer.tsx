import { PrivateImage } from './PrivateImage';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ActionInstance, ActionMeta, Appearance, IconRef, Profile } from '../../../src/shared/types.ts';
import type { ActionChoice } from '../../../src/shared/action-presets.ts';
import { actionSummary, validateActionSetup } from '../../../src/shared/action-setup.ts';
import { validateScriptArguments, type ScriptArgument } from '../../../src/shared/script-arguments.ts';
import { client } from '../api.ts';
import { FieldsForm, type FieldCtx } from './Fields.tsx';
import { Icon } from './Icon.tsx';
import { IconPicker } from './Inspector.tsx';
import type { Slot } from './DeviceView.tsx';
import '../integration-setup.css';

type AppearancePatch = Omit<Appearance, 'icon'> & { icon?: IconRef | null };

interface Props {
  choice: ActionChoice; meta: ActionMeta; profile: Profile; profiles: Profile[]; pageId: string;
  catalog: Map<string, ActionMeta>; initialSlot: Slot; onClose(): void;
  instance?: ActionInstance;
  focusAppearance?: boolean;
  onSave(slot: Slot, settings: Record<string, unknown>, appearance: AppearancePatch, replaceFolder: boolean): Promise<void>;
}
const COLORS = ['#0f172a', '#163456', '#2c2350', '#3f2235', '#10443d', '#4a301e'];
interface ScriptInfo { title: string; description?: string; arguments: ScriptArgument[]; warnings: string[] }

export function ActionComposer(p: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const isAgent = p.meta.type.startsWith('agent.');
  const isScript = p.meta.type === 'system.script';
  const isShortcut = p.meta.type === 'system.shortcut';
  const launcher = p.meta.type === 'system.raycast' ? 'Raycast' : p.meta.type === 'system.asyar' ? 'Asyar' : null;
  const [slot, setSlot] = useState<Slot>(p.initialSlot);
  const [settings, setSettings] = useState<Record<string, unknown>>(() => {
    const draft: Record<string, unknown> = {
      ...structuredClone(p.meta.defaults),
      ...(isAgent ? { execution: 'terminal' } : {}),
      ...(isScript && !p.instance ? { showOutput: false } : {}),
      ...structuredClone(p.choice.settings),
    };
    const previous = p.initialSlot.kind === 'key' ? p.profile.pages[p.pageId]?.keys[p.initialSlot.index] : null;
    if (isAgent && !draft.cwd && previous?.type.startsWith('agent.')) draft.cwd = previous.settings.cwd;
    return draft;
  });
  const [title, setTitle] = useState(p.instance ? p.instance.appearance.title ?? '' : p.choice.appearance?.title || p.choice.name);
  const titleEdited = useRef(!!p.instance);
  const presetIcon = useRef<IconRef | null>(p.instance ? p.instance.appearance.icon ?? null
    : p.choice.icon === p.meta.icon ? null : { kind: 'lucide', name: p.choice.icon });
  const [icon, setIcon] = useState<IconRef | 'app' | null>(presetIcon.current);
  const [pickingIcon, setPickingIcon] = useState(false);
  const iconButton = useRef<HTMLButtonElement>(null);
  const initialColor = p.instance ? p.instance.appearance.bg || '#000000' : p.choice.appearance?.bg || COLORS[0]!;
  const [color, setColor] = useState(initialColor);
  const colorEdited = useRef(false);
  const iconEdited = useRef(false);
  const [appIconFor, setAppIconFor] = useState<{ path: string; id: string | null } | null>(null);
  const appIcon = appIconFor?.id ?? null;
  const initialTitle = useRef(title);
  const [busy, setBusy] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [error, setError] = useState('');
  const [confirmedFolderId, setConfirmedFolderId] = useState<string | null>(null);
  const [agentStatus, setAgentStatus] = useState<'checking' | 'available' | 'unavailable' | 'unknown'>('checking');
  const [agentCheck, setAgentCheck] = useState(0);
  const [shortcutNames, setShortcutNames] = useState<string[]>([]);
  const [scriptInfo, setScriptInfo] = useState<ScriptInfo | null>(null);
  const [scriptError, setScriptError] = useState('');
  const [scriptCheck, setScriptCheck] = useState(0);
  const [inspecting, setInspecting] = useState(false);
  const revealSessionAtStart = useRef(isAgent && settings.mode === 'continue');
  const errorSummary = useRef<HTMLDivElement>(null);
  const errorId = `setup-errors-${useId()}`;
  const [serverInvalidField, setServerInvalidField] = useState<string>();
  const page = p.profile.pages[p.pageId]!;
  const previous = (slot.kind === 'key' ? page.keys : page.dials)[slot.index];
  const replaceFolder = !!previous && previous.id === confirmedFolderId;
  const replacing = !!previous && !p.instance;
  const scriptPath = isScript ? String(settings.path ?? '') : '';
  const currentScriptPath = useRef(scriptPath);
  const rawArgs = [1, 2, 3].map((index) => String(settings[`arg${index}`] ?? ''));
  const passwordScript = scriptInfo?.arguments.some((a) => a.type === 'password');
  const fields = p.meta.fields.filter((f) => f.type !== 'folder' && (!f.controllers || f.controllers.includes(slot.kind)) && !(isAgent && settings.mode === 'continue' && f.key === 'prompt') && !(passwordScript && /^arg[1-3]$/.test(f.key))).map((field) => {
    if (isAgent && field.key === 'cwd') return { ...field, help: undefined };
    if (isAgent && field.key === 'mode') return { ...field, options: [{ value: 'new', label: 'Start a new session' }, { value: 'continue', label: 'Continue the last session' }] };
    if (isAgent && field.key === 'prompt') return { ...field, required: settings.execution === 'background' };
    if (isScript && field.key === 'path') return { ...field, label: 'Script file', help: 'Choose an executable script or paste its path.' };
    if (isShortcut && field.key === 'name') return { ...field, placeholder: 'Choose or type a shortcut', help: shortcutNames.length ? undefined : 'Use the name shown in the Shortcuts app.' };
    if (launcher && field.key === 'url') return { ...field, label: 'Command link', help: launcher === 'Raycast' ? 'In Raycast, select the command, open its Action Panel, and choose Copy Deeplink.' : 'Paste the command link from an installed Asyar extension.' };
    const spec = scriptInfo?.arguments.find((a) => field.key === `arg${a.index}`);
    return spec ? { ...field, label: spec.placeholder, required: !spec.optional, type: spec.type === 'dropdown' ? 'select' as const : 'text' as const, options: spec.type === 'dropdown' ? [{ title: 'Choose a value…', value: '' }, ...(spec.data ?? [])].map((c) => ({ label: c.title, value: c.value })) : undefined, help: spec.percentEncoded ? 'URL-encoded once when the script runs.' : spec.optional ? 'Optional script argument.' : 'Required by this script.' } : field;
  });
  const meta = { ...p.meta, fields };
  // Keep the draft task if the user switches back to New session before saving.
  const savedSettings = isAgent && settings.mode === 'continue' ? { ...settings, prompt: '' } : settings;
  const validation = [...validateActionSetup(isScript ? p.meta : meta, savedSettings, slot.kind, (type) => p.catalog.get(type)), ...(isScript && scriptInfo ? validateScriptArguments(scriptInfo.arguments, rawArgs) : [])];
  const invalidFields = fields.filter((f) => f.required && !String(settings[f.key] ?? '').trim()).map((f) => f.key);
  if (launcher && validation.length) invalidFields.push('url');
  if (isShortcut && validation.length) invalidFields.push('name');
  if (p.meta.type === 'system.hotkey' && slot.kind === 'key' && !(settings.hotkey as { key?: string } | null)?.key) invalidFields.push('hotkey');
  if (slot.kind === 'dial' && ['system.hotkey', 'system.command'].includes(p.meta.type) && validation.length) invalidFields.push('left');
  if (scriptInfo) for (const spec of scriptInfo.arguments) if (validateScriptArguments([spec], rawArgs).length) invalidFields.push(`arg${spec.index}`);
  if (serverInvalidField) invalidFields.push(serverInvalidField);
  const ctx: FieldCtx = { profile: p.profile, profiles: p.profiles, catalog: p.catalog, onOpenFolder: () => {} };
  const projectFolders = useMemo(() => {
    if (!isAgent) return [];
    const folders = new Set<string>();
    for (const profile of p.profiles) {
      for (const page of Object.values(profile.pages)) {
        for (const action of page.keys) {
          if (action?.type.startsWith('agent.') && typeof action.settings.cwd === 'string' && action.settings.cwd.trim()) {
            folders.add(action.settings.cwd);
          }
        }
      }
    }
    return [...folders].slice(0, 20);
  }, [isAgent, p.profiles]);
  const label = `${slot.kind === 'key' ? 'Key' : 'Dial'} ${slot.index + 1}`;
  const previewIcon = icon === 'app' ? appIcon ? { kind: 'image' as const, id: appIcon } : null : icon;
  const iconLabel = icon === 'app' ? 'App icon' : icon?.kind === 'lucide' ? icon.name.replaceAll('-', ' ')
    : icon?.kind === 'emoji' ? icon.char : icon?.kind === 'image' ? 'Custom image' : icon?.kind === 'none' ? 'No icon' : 'Automatic';
  const closeIconPicker = () => {
    setPickingIcon(false);
    requestAnimationFrame(() => iconButton.current?.focus({ preventScroll: true }));
  };
  const scriptInputs = fields.filter((field) => /^arg[1-3]$/.test(field.key) && field.required);
  const extraScriptFields = fields.filter((f) => f.key !== 'path' && !scriptInputs.includes(f));
  const revealFocusedControl = () => requestAnimationFrame(() => {
    const control = document.activeElement;
    if (control instanceof HTMLElement && dialog.current?.querySelector('.composer-body')?.contains(control)) {
      control.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  });

  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    const sheet = dialog.current;
    sheet?.showModal();
    const firstField = (!p.instance ? iconButton.current : p.focusAppearance ? sheet?.querySelector<HTMLElement>('#key-label') : null)
      ?? sheet?.querySelector<HTMLElement>('[aria-required="true"]')
      ?? sheet?.querySelector<HTMLElement>('[id^="f-"]');
    firstField?.focus();
    revealFocusedControl();
    window.addEventListener('resize', revealFocusedControl);
    return () => {
      window.removeEventListener('resize', revealFocusedControl);
      sheet?.close();
      if (before?.isConnected) before.focus();
    };
  }, []);
  useEffect(() => {
    if (!isAgent) return;
    let live = true;
    void client.rpc<{ agents: { tool: string; installed: boolean }[] }>('integrations.status').then(({ agents }) => {
      if (!live) return;
      const result = agents.find((agent) => agent.tool === p.meta.type.slice(6));
      setAgentStatus(result ? result.installed ? 'available' : 'unavailable' : 'unknown');
    }).catch(() => { if (live) setAgentStatus('unknown'); });
    return () => { live = false; };
  }, [isAgent, p.meta.type, agentCheck]);
  useEffect(() => {
    if (!isShortcut) return;
    let live = true;
    void client.rpc<string[]>('shortcuts.list').then((names) => {
      if (live) setShortcutNames(names);
    }).catch(() => { /* Name entry remains available. */ });
    return () => { live = false; };
  }, [isShortcut]);
  useEffect(() => {
    if (!scriptPath.trim()) return;
    let live = true;
    const isCurrent = () => live && currentScriptPath.current === scriptPath;
    setInspecting(true);
    const timer = window.setTimeout(() => {
      void client.rpc<ScriptInfo>('scripts.inspect', { path: scriptPath }).then((info) => {
        if (!isCurrent()) return;
        setScriptInfo(info);
        if (!titleEdited.current) setTitle(info.title);
      }).catch((failure: Error) => {
        if (isCurrent()) setScriptError(failure.message);
      }).finally(() => { if (isCurrent()) setInspecting(false); });
    }, 300);
    return () => { live = false; window.clearTimeout(timer); };
  }, [scriptPath, scriptCheck]);
  // Open-app buttons use the app's real icon and name unless the user picks their own.
  useEffect(() => {
    if (p.meta.type !== 'system.open') return;
    const path = String(settings.path ?? '').trim();
    let live = true;
    const t = setTimeout(() => {
      if (!path) {
        setAppIconFor(null);
        if (!p.instance && !iconEdited.current) setIcon(presetIcon.current);
        return;
      }
      void client.rpc<string | null>('host.appIcon', { app: path }).catch(() => null).then((id) => {
        if (!live) return;
        setAppIconFor({ path, id });
        if (!p.instance && !iconEdited.current) setIcon(id ? 'app' : presetIcon.current);
        if (id && !titleEdited.current) {
          const name = path.replace(/\/+$/, '').split('/').pop()!.replace(/\.app$/i, '');
          const previous = initialTitle.current; // compared before React runs the updater
          setTitle((current) => (current === previous || current === '' ? name : current));
          initialTitle.current = name;
        }
      });
    }, 300);
    return () => { live = false; clearTimeout(t); };
  }, [settings.path]);

  const change = (patch: Record<string, unknown>) => {
    setError(''); setServerInvalidField(undefined);
    setSettings((s) => ({ ...s, ...patch, ...(isAgent && patch.execution === 'background' ? { mode: 'new' } : {}) }));
    if (isScript && 'path' in patch && patch.path !== scriptPath) {
      currentScriptPath.current = String(patch.path ?? '');
      setScriptInfo(null);
      setScriptError('');
      setInspecting(false);
      if (!titleEdited.current) setTitle(initialTitle.current);
    }
  };
  const focusProblem = (field?: string) => requestAnimationFrame(() => {
    const control = field ? dialog.current?.querySelector<HTMLElement>(`[id^="f-${field}-"]`) : null;
    if (control) {
      const disclosure = control.closest('details');
      if (disclosure) disclosure.open = true;
      control.focus();
      control.scrollIntoView({ block: 'nearest' });
    }
    else errorSummary.current?.focus();
  });
  const save = async () => {
    if (busy) return;
    setAttempted(true); setError('');
    if (validation.length) { focusProblem(fields.find((field) => invalidFields.includes(field.key))?.key); return; }
    if (previous?.type === 'sd.folder' && !p.instance && !replaceFolder) { setError('Confirm replacing this folder and its contents.'); focusProblem(); return; }
    setBusy(true);
    try {
      let savedTitle = title;
      const appPath = String(settings.path ?? '').trim();
      const autoAppIcon = !p.instance && p.meta.type === 'system.open' && !iconEdited.current;
      if (autoAppIcon && !titleEdited.current && p.choice.id === 'system.open') {
        savedTitle = appPath.replace(/\/+$/, '').split('/').at(-1)?.replace(/\.app$/i, '') || title;
      }
      if (isScript) {
        const info = await client.rpc<ScriptInfo>('scripts.inspect', { path: scriptPath });
        setScriptInfo(info);
        if (!titleEdited.current) {
          savedTitle = info.title;
          setTitle(savedTitle);
        }
        const errors = validateScriptArguments(info.arguments, rawArgs);
        if (errors.length) { const invalid = info.arguments.find((a) => a.type !== 'password' && validateScriptArguments([a], rawArgs).length); setError(errors[0]!); setBusy(false); focusProblem(invalid ? `arg${invalid.index}` : undefined); return; }
      }
      const appearance: AppearancePatch = {};
      if (!p.instance || savedTitle !== (p.instance.appearance.title ?? '')) appearance.title = p.instance ? savedTitle.trim() : savedTitle.trim() || p.choice.name;
      if (!p.instance || colorEdited.current) appearance.bg = color;
      let savedAppIcon = appIcon;
      if ((autoAppIcon || icon === 'app') && appIconFor?.path !== appPath) {
        // Saving immediately after typing should use the same icon as waiting for the preview.
        savedAppIcon = await client.rpc<string | null>('host.appIcon', { app: settings.path }).catch(() => null);
      }
      if ((autoAppIcon || icon === 'app') && savedAppIcon) appearance.icon = { kind: 'image', id: savedAppIcon };
      else if (icon !== 'app' && (p.instance ? iconEdited.current : icon)) appearance.icon = icon;
      await p.onSave(slot, savedSettings, appearance, replaceFolder);
    }
    catch (e) { const field = isAgent ? 'cwd' : isScript ? 'path' : undefined; setServerInvalidField(field); setError((e as Error).message); setBusy(false); focusProblem(field); }
  };
  const submitExplicitly = (form: HTMLFormElement) => {
    if (!replacing) form.requestSubmit();
    else if (form.reportValidity()) void save();
  };
  const renderFields = (formFields: ActionMeta['fields']) => <FieldsForm
    meta={{ ...meta, fields: formFields }}
    controller={slot.kind}
    settings={settings}
    onChange={change}
    ctx={ctx}
    immediate
    preserveStartingTask={isAgent}
    invalidFields={attempted || error || scriptError ? [...invalidFields, ...(scriptError ? ['path'] : [])] : []}
    errorId={error || attempted && validation.length ? errorId : scriptError ? `${errorId}-script` : undefined}
    suggestions={isShortcut ? { field: 'name', values: shortcutNames } : isAgent ? { field: 'cwd', values: projectFolders } : undefined}
  />;
  const primaryFields = fields.filter((field) =>
    isAgent ? ['cwd', 'prompt', 'execution'].includes(field.key) : isScript ? field.key === 'path' : true);
  const description = isAgent ? settings.execution === 'background' ? `Press the key to run this prompt with ${p.meta.name}.` : `Press the key to open ${p.meta.name} in Terminal.`
    : p.instance ? actionSummary(p.meta, settings, slot.kind) : p.choice.description;

  return <dialog
    ref={dialog}
    className="action-composer compact-setup"
    aria-labelledby="composer-title"
    onCancel={(e) => { e.preventDefault(); if (!busy) p.onClose(); }}
  >
    <form onSubmit={(e) => {
      e.preventDefault();
      // Enter in a single-line field can submit a form without activating the footer.
      if (!replacing) void save();
    }} aria-busy={busy} onKeyDown={(e) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key === 'Enter' && !e.nativeEvent.isComposing) {
        e.preventDefault();
        if (!e.repeat) submitExplicitly(e.currentTarget);
      }
    }}>
      <header className="composer-header">
        <div className="action-tile" style={{ background: color }} aria-hidden="true">
          {previewIcon?.kind === 'image' ? <PrivateImage id={previewIcon.id} />
            : previewIcon?.kind === 'emoji' ? <span className="preview-emoji">{previewIcon.char}</span>
            : previewIcon?.kind === 'none' ? <span />
            : <Icon name={previewIcon?.kind === 'lucide' ? previewIcon.name : p.meta.icon} size={23} />}
          {p.instance?.appearance.showTitle !== false ? <span className="preview-title">{title || p.choice.name}</span> : null}
        </div>
        <div className="grow">
          <h2 id="composer-title">{p.instance?.appearance.title?.trim() || p.choice.name}</h2>
          <p>{description}</p>
        </div>
      </header>
      {(attempted && validation.length > 0) || error ? <div ref={errorSummary} id={errorId} className="composer-error-summary" role="alert" tabIndex={-1}>
        <Icon name="circle-alert" size={16} />
        <div>{[...new Set([...(attempted ? validation : []), ...(error ? [error] : [])])].map((message) => <p key={message}>{message}</p>)}</div>
      </div> : null}
      <div className="composer-body" inert={busy} onFocusCapture={revealFocusedControl}>
        <div className="composer-fields">
          <details className="setup-disclosure setup-appearance" open={!p.instance || p.focusAppearance || fields.length <= 1 || undefined}>
            <summary><Icon name="chevron-right" size={14} /> Icon &amp; label</summary>
            <div className="setup-icon-row">
              <button ref={iconButton} type="button" className="secondary" onClick={() => pickingIcon ? closeIconPicker() : setPickingIcon(true)}
                aria-expanded={pickingIcon}><Icon name="shapes" size={15} /> Choose icon…</button>
              <span className="muted">{iconLabel}</span>
              {appIcon && icon !== 'app' && <button type="button" className="link" onClick={() => {
                iconEdited.current = true;
                setIcon('app');
              }}>Use app icon</button>}
            </div>
            {pickingIcon && <IconPicker current={icon === 'app' ? previewIcon ?? undefined : icon ?? undefined}
              onClose={closeIconPicker} onPick={picked => { iconEdited.current = true; setIcon(picked); closeIconPicker(); }} />}
            <div className="composer-look">
              <label className="field">
                <span>Button label</span>
                <input id="key-label" aria-label="Button label" value={title} onChange={(e) => { titleEdited.current = true; setTitle(e.target.value); }} maxLength={60} />
              </label>
              <div className="field">
                <span>Color</span>
                <div className="color-choices">{[...new Set([...COLORS, initialColor])].map(c => <button type="button" key={c}
                  aria-label={`Color ${c}`} aria-pressed={color === c} className={color === c ? 'on' : ''} style={{ background: c }}
                  onClick={() => { colorEdited.current = true; setColor(c); }}>{color === c ? <Icon name="check" size={13} /> : null}</button>)}</div>
              </div>
            </div>
          </details>
          {primaryFields.length > 0 ? <section className="setup-essential">
            <h3>Action settings</h3>
            {renderFields(primaryFields)}
          </section> : null}

          {isAgent ? <>
            <div className={`setup-feedback ${agentStatus === 'unavailable' ? 'setup-warning' : ''}`} role="status">
              <Icon name={agentStatus === 'available' ? 'circle-check' : 'terminal'} size={16} />
              <span>{{
                checking: 'Checking for the CLI…',
                available: 'CLI found. Uses your CLI sign-in.',
                unavailable: 'CLI unavailable. Install it before running this key.',
                unknown: 'CLI status unavailable.',
              }[agentStatus]}</span>
              {['unavailable', 'unknown'].includes(agentStatus) ? <button type="button" className="ghost" onClick={() => {
                setAgentStatus('checking');
                setAgentCheck((check) => check + 1);
              }}>Check again</button> : null}
            </div>
            {settings.execution !== 'background' && <details className="setup-disclosure" open={revealSessionAtStart.current || undefined}>
              <summary>
                <Icon name="chevron-right" size={14} /> Session options
                <span>{settings.mode === 'continue' ? 'Continue last' : settings.prompt ? 'Task included' : 'New session'}</span>
              </summary>
              {renderFields(fields.filter((field) => !['cwd', 'prompt', 'execution'].includes(field.key)))}
            </details>}
          </> : null}

          {isScript && scriptPath.trim() ? <>
            {inspecting ? <div className="setup-feedback" role="status"><Icon name="file-search" size={16} /> Reading script inputs…</div> : null}
            {scriptError ? <div className="setup-feedback setup-warning" id={`${errorId}-script`} role="status">
              <Icon name="circle-alert" size={16} />
              <span>{scriptError}</span>
              <button type="button" className="ghost" onClick={() => { setScriptError(''); setScriptCheck((check) => check + 1); }}>Retry</button>
            </div> : null}
            {scriptInfo ? <>
              <div className="setup-feedback" role="status"><Icon name="circle-check" size={16} /><span>Script file checked.</span></div>
              {scriptInfo.description ? <p className="setup-description">{scriptInfo.description}</p> : null}
              {scriptInfo.warnings.map((warning) => <p className="setup-description warn" key={warning}>{warning}</p>)}
              {scriptInputs.length ? renderFields(scriptInputs) : null}
              <details className="setup-disclosure">
                <summary><Icon name="chevron-right" size={14} /> Script options</summary>
                {renderFields(extraScriptFields)}
              </details>
            </> : null}
          </> : null}

          {p.choice.note ? <p className="setup-description warn">{p.choice.note}</p> : null}

          {previous && !p.instance ? <p className="setup-description warn">Replaces {previous.appearance.title || p.catalog.get(previous.type)?.name || 'the current action'}.</p> : null}
          {previous?.type === 'sd.folder' && !p.instance ? <label className="check warn">
            <input type="checkbox" checked={replaceFolder} onChange={(e) => { setConfirmedFolderId(e.target.checked ? previous.id : null); setError(''); }} /> Replace this folder and remove its contents
          </label> : null}
        </div>
      </div>
      <footer className="composer-footer">
        {p.instance ? <span className="setup-slot">{label}</span> : (
          <select className="setup-slot" aria-label="Target button" disabled={busy} value={`${slot.kind}:${slot.index}`} onChange={(e) => {
            const [kind, index] = e.target.value.split(':');
            setSlot({ kind: kind as Slot['kind'], index: Number(index) });
            setConfirmedFolderId(null);
            setError('');
          }}>
            {(['key', 'dial'] as const).filter((kind) => p.meta.controllers.includes(kind)).flatMap((kind) =>
              (kind === 'key' ? page.keys : page.dials).map((action, index) => <option key={`${kind}:${index}`} value={`${kind}:${index}`}>
                {kind === 'key' ? 'Key' : 'Dial'} {index + 1} · {action ? action.appearance.title || p.catalog.get(action.type)?.name || action.type : 'Empty'}
              </option>))}
          </select>
        )}
        <div className="setup-actions">
          <button type="button" className="secondary" disabled={busy} onClick={p.onClose}>Cancel</button>
          <button className="primary" type={replacing ? 'button' : 'submit'} disabled={busy}
            aria-keyshortcuts="Meta+Enter Control+Enter"
            onClick={replacing ? (e) => { if (e.currentTarget.form) submitExplicitly(e.currentTarget.form); } : undefined}>
            {busy ? 'Saving…' : p.instance ? 'Save changes' : replacing ? `Replace ${label}` : `Add to ${label}`}
            <kbd aria-hidden="true">⌘↩</kbd>
          </button>
        </div>
      </footer>
    </form>
  </dialog>;
}
