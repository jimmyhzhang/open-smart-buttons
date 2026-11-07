// Settings form generated from an action's field schema, plus the hotkey recorder and the
// multi-action step editor.

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ActionInstance, ActionMeta, Controller, Field, Hotkey, Profile } from '../../../src/shared/types.ts';
import { Icon } from './Icon.tsx';
import { client, toast } from '../api.ts';

let hostInfo: Promise<{ canPick: boolean }> | null = null;
function useCanPick(): boolean {
  const [can, setCan] = useState(false);
  useEffect(() => {
    hostInfo ??= client.rpc<{ canPick: boolean }>('host.info').catch(() => ({ canPick: false }));
    let live = true;
    void hostInfo.then((h) => live && setCan(!!h?.canPick));
    return () => { live = false; };
  }, []);
  return can;
}

let appList: Promise<{ name: string; path: string }[]> | null = null;
/** One shared <datalist> of installed apps for app fields. */
export function InstalledAppsList() {
  const [apps, setApps] = useState<{ name: string; path: string }[]>([]);
  useEffect(() => {
    appList ??= client.rpc<{ name: string; path: string }[]>('host.apps').catch(() => []);
    let live = true;
    void appList.then((a) => live && setApps(a ?? []));
    return () => { live = false; };
  }, []);
  return <datalist id="installed-apps">{apps.map((a) => <option key={a.path} value={a.name} />)}</datalist>;
}

export function formatHotkey(h: Hotkey | null | undefined): string {
  if (!h?.key) return '';
  return `${h.ctrl ? '⌃' : ''}${h.opt ? '⌥' : ''}${h.shift ? '⇧' : ''}${h.cmd ? '⌘' : ''}${h.key.length === 1 ? h.key.toUpperCase() : h.key}`;
}

function keyFromEvent(e: KeyboardEvent): string | null {
  const c = e.code;
  if (/^Key[A-Z]$/.test(c)) return c.slice(3).toLowerCase();
  if (/^Digit\d$/.test(c)) return c.slice(5);
  if (/^F\d{1,2}$/.test(c)) return c;
  const map: Record<string, string> = {
    ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Space: 'Space', Enter: 'Enter', NumpadEnter: 'Enter',
    Escape: 'Escape', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
    Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backquote: '`',
  };
  return map[c] ?? null;
}

export function HotkeyInput({ value, onChange, id, label = 'Shortcut', invalid, describedBy }: { value: Hotkey | null; onChange(h: Hotkey | null): void; id?: string; label?: string; invalid?: boolean; describedBy?: string }) {
  const [rec, setRec] = useState(false);
  useEffect(() => {
    if (!rec) return;
    const h = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat) return;
      if (['Meta', 'Control', 'Alt', 'Shift'].includes(e.key)) return;
      const key = keyFromEvent(e);
      if (key === 'Escape' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        setRec(false);
        return;
      }
      if (!key) return;
      onChange({ key, cmd: e.metaKey, ctrl: e.ctrlKey, opt: e.altKey, shift: e.shiftKey });
      setRec(false);
    };
    window.addEventListener('keydown', h, true);
    return () => window.removeEventListener('keydown', h, true);
  }, [rec, onChange]);
  return (
    <div className="hotkey">
      <button type="button" id={id} aria-label={`${label}: ${rec ? 'recording' : formatHotkey(value) || 'record shortcut'}`} aria-pressed={rec} aria-invalid={invalid || undefined} aria-describedby={describedBy} className={`hotkey-btn ${rec ? 'rec' : ''}`} onClick={() => setRec(!rec)}>
        {rec ? 'Press the shortcut… (Esc cancels)' : formatHotkey(value) || 'Click to record'}
      </button>
      {value ? (
        <button type="button" className="ghost icon-btn" aria-label={`Clear ${label.toLowerCase()}`} onClick={() => onChange(null)}>
          <Icon name="x" size={14} />
        </button>
      ) : null}
    </div>
  );
}

export interface FieldCtx {
  profile: Profile;
  profiles: Profile[];
  catalog: Map<string, ActionMeta>;
  onOpenFolder(id: string): void;
}

export function FieldsForm(props: {
  meta: ActionMeta;
  controller: Controller;
  settings: Record<string, any>;
  onChange(patch: Record<string, unknown>): void;
  ctx: FieldCtx;
  immediate?: boolean;
  invalidFields?: readonly string[];
  errorId?: string;
  suggestions?: { field: string; values: readonly string[] };
  preserveStartingTask?: boolean;
}) {
  const fields = props.meta.fields.filter((f) => (!f.controllers || f.controllers.includes(props.controller)) && !(props.meta.type.startsWith('agent.') && props.settings.mode === 'continue' && f.key === 'prompt'));
  if (!fields.length) return null;
  return (
    <div className="fields">
      {fields.map((f) => (
        <FieldRow key={f.key} f={f} value={props.settings[f.key]} onChange={(v) => props.onChange({ [f.key]: v, ...(!props.preserveStartingTask && props.meta.type.startsWith('agent.') && f.key === 'mode' && v === 'continue' ? { prompt: '' } : {}) })} ctx={props.ctx} immediate={props.immediate} invalid={props.invalidFields?.includes(f.key)} errorId={props.errorId} suggestions={props.suggestions?.field === f.key ? props.suggestions.values : undefined} />
      ))}
    </div>
  );
}

function FieldRow({ f, value, onChange, ctx, immediate, invalid, errorId, suggestions }: { f: Field; value: any; onChange(v: unknown): void; ctx: FieldCtx; immediate?: boolean; invalid?: boolean; errorId?: string; suggestions?: readonly string[] }) {
  const id = `f-${f.key}-${useId()}`;
  const describedBy = [f.help ? `${id}-help` : '', invalid ? errorId : ''].filter(Boolean).join(' ') || undefined;
  const attributes = { 'data-field-key': f.key, 'aria-required': f.required, 'aria-invalid': invalid || undefined, 'aria-describedby': describedBy };
  const canPick = useCanPick();
  const [picking, setPicking] = useState(false);
  const pages = useMemo(() => ctx.profile.pageOrder.map((pid) => ctx.profile.pages[pid]!).filter(Boolean), [ctx.profile]);
  let control: React.ReactNode;
  switch (f.type) {
    case 'text':
      control = immediate ? <input id={id} {...attributes} list={suggestions?.length ? `${id}-suggestions` : f.suggest === 'apps' ? 'installed-apps' : undefined} autoComplete="off" spellCheck={false} value={value ?? ''} placeholder={f.placeholder} onChange={(e) => onChange(e.target.value)} /> : <DebouncedInput id={id} list={f.suggest === 'apps' ? 'installed-apps' : undefined} value={value ?? ''} placeholder={f.placeholder} onChange={onChange} />;
      if (f.browse) control = <div className="path-field">{control}{canPick && <button type="button" className="secondary browse-btn" disabled={picking} aria-label={`Browse for ${f.label.toLowerCase()}`} onClick={async () => {
        setPicking(true);
        try {
          const picked = await client.rpc<string | null>('host.choose', { kind: f.browse, prompt: `Choose ${f.browse === 'app' ? 'an app' : f.browse === 'folder' ? 'a folder' : 'a file'} for “${f.label}”` });
          if (picked) onChange(picked);
        } catch (e) { toast((e as Error).message, 'error'); }
        finally { setPicking(false); }
      }}><Icon name={f.browse === 'app' ? 'app-window' : f.browse === 'folder' ? 'folder-open' : 'file'} size={14} />{picking ? 'Choosing…' : 'Browse…'}</button>}</div>;
      break;
    case 'textarea':
      control = immediate ? <textarea id={id} {...attributes} value={value ?? ''} placeholder={f.placeholder} onChange={(e) => onChange(e.target.value)} rows={4} /> : <DebouncedInput id={id} value={value ?? ''} placeholder={f.placeholder} onChange={onChange} multiline />;
      break;
    case 'number':
      control = <input id={id} type="number" min={f.min} max={f.max} step={f.step} value={value ?? 0} onChange={(e) => onChange(Number(e.target.value))} />;
      break;
    case 'slider':
      control = (
        <div className="slider-row">
          <input id={id} type="range" min={f.min} max={f.max} step={f.step} value={value ?? f.min ?? 0} onChange={(e) => onChange(Number(e.target.value))} />
          <output>{value}</output>
        </div>
      );
      break;
    case 'select':
      control = (
        <select id={id} {...attributes} value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
          {f.options?.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      );
      break;
    case 'toggle':
      return (
        <label className="check">
          <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} />
          <span>{f.label}</span>
        </label>
      );
    case 'hotkey':
      control = <HotkeyInput id={id} label={f.label} invalid={invalid} describedBy={describedBy} value={value ?? null} onChange={onChange} />;
      break;
    case 'page':
      control = (
        <select id={id} value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
          <option value="">Choose a page</option>
          {pages.map((p, i) => (
            <option key={p.id} value={p.id}>
              {i + 1}. {p.name}
            </option>
          ))}
        </select>
      );
      break;
    case 'profile':
      control = <ProfileSelect id={id} value={value} onChange={onChange} ctx={ctx} />;
      break;
    case 'folder':
      control = value ? (
        <button type="button" className="secondary" onClick={() => ctx.onOpenFolder(String(value))}>
          <Icon name="folder-open" size={15} /> Open folder “{ctx.profile.pages[String(value)]?.name ?? 'Folder'}”
        </button>
      ) : (
        <span className="muted">No folder yet</span>
      );
      break;
    case 'steps':
      control = <StepsEditor steps={(value as ActionInstance[]) ?? []} onChange={onChange} ctx={ctx} immediate={immediate} />;
      break;
  }
  return (
    <div className="field">
      <label htmlFor={id}>{f.label}{f.required ? <span aria-hidden="true"> *</span> : null}</label>
      {control}
      {suggestions?.length ? <datalist id={`${id}-suggestions`}>{suggestions.map((name) => <option key={name} value={name} />)}</datalist> : null}
      {f.help ? <p id={`${id}-help`} className="help">{f.help}</p> : null}
    </div>
  );
}

function ProfileSelect({ id, value, onChange, ctx }: { id: string; value: any; onChange(v: unknown): void; ctx: FieldCtx }) {
  const [creating, setCreating] = useState(false);
  const profiles = ctx.profiles.filter(p => p.modelId === ctx.profile.modelId && p.id !== ctx.profile.id);
  const create = async () => {
    if (creating) return;
    setCreating(true);
    try {
      const profileId = await client.rpc<string>('profiles.create', { name: 'Untitled Profile', modelId: ctx.profile.modelId });
      onChange(profileId);
      requestAnimationFrame(() => document.getElementById(id)?.focus({ preventScroll: true }));
    } catch (error) { toast((error as Error).message, 'error'); }
    finally { setCreating(false); }
  };
  return (
    <>
      <select id={id} value={value ?? ''} disabled={!profiles.length} onChange={(e) => onChange(e.target.value)}>
        <option value="">{profiles.length ? 'Choose a profile' : 'Create another profile to switch to'}</option>
        {profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
      {!profiles.length && <button type="button" className="secondary" disabled={creating} onClick={() => void create()}>
        <Icon name="plus" size={14} />{creating ? 'Creating…' : 'Create a profile'}
      </button>}
    </>
  );
}

export function DebouncedInput(props: { id?: string; value: string; placeholder?: string; onChange(v: string): void; multiline?: boolean; ariaLabel?: string; list?: string }) {
  const [v, setV] = useState(props.value);
  const timer = useRef(0);
  const last = useRef(props.value);
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    if (props.value !== last.current) {
      clearTimeout(timer.current);
      setV(props.value);
      last.current = props.value;
    }
  }, [props.value]);
  const change = (nv: string) => {
    setV(nv);
    last.current = nv;
    clearTimeout(timer.current);
    timer.current = window.setTimeout(() => props.onChange(nv), 250);
  };
  return props.multiline ? (
    <textarea id={props.id} aria-label={props.ariaLabel} rows={2} value={v} placeholder={props.placeholder} onChange={(e) => change(e.target.value)} spellCheck={false} />
  ) : (
    <input id={props.id} aria-label={props.ariaLabel} list={props.list} autoComplete="off" value={v} placeholder={props.placeholder} onChange={(e) => change(e.target.value)} spellCheck={false} />
  );
}

function StepsEditor({ steps, onChange, ctx, immediate }: { steps: ActionInstance[]; onChange(v: unknown): void; ctx: FieldCtx; immediate?: boolean }) {
  const options = [...ctx.catalog.values()].filter((m) => (m.controllers.includes('key') && !['sd.multi', 'sd.folder', 'util.clock'].includes(m.type) && m.category !== 'Hidden') || m.type === 'sd.delay');
  const set = (i: number, s: ActionInstance | null) => {
    const next = [...steps];
    if (s) next[i] = s;
    else next.splice(i, 1);
    onChange(next);
  };
  const move = (i: number, d: number) => {
    const next = [...steps];
    const [x] = next.splice(i, 1);
    next.splice(i + d, 0, x!);
    onChange(next);
  };
  return (
    <div className="steps">
      {steps.map((s, i) => {
        const meta = ctx.catalog.get(s.type);
        return (
          <div className="step" key={s.id} role="group" aria-label={`Step ${i + 1}`}>
            <div className="step-head">
              <span className="step-n">{i + 1}</span>
              <select
                aria-label={`Step ${i + 1} action`}
                value={s.type}
                onChange={(e) => {
                  const m = ctx.catalog.get(e.target.value)!;
                  set(i, { id: s.id, type: m.type, settings: structuredClone(m.defaults), appearance: {} });
                }}
              >
                {options.map((o) => (
                  <option key={o.type} value={o.type}>
                    {o.name}
                  </option>
                ))}
              </select>
              <button type="button" className="ghost icon-btn" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}>
                <Icon name="arrow-up" size={14} />
              </button>
              <button type="button" className="ghost icon-btn" aria-label="Move down" disabled={i === steps.length - 1} onClick={() => move(i, 1)}>
                <Icon name="arrow-down" size={14} />
              </button>
              <button type="button" className="ghost icon-btn" aria-label="Remove step" onClick={() => set(i, null)}>
                <Icon name="trash-2" size={14} />
              </button>
            </div>
            {meta ? (
              <FieldsForm meta={meta} controller="key" settings={s.settings} ctx={ctx} immediate={immediate} onChange={(patch) => set(i, { ...s, settings: { ...s.settings, ...patch } })} />
            ) : null}
          </div>
        );
      })}
      <div className="step-add">
        <button type="button"
          className="secondary"
          onClick={() => onChange([...steps, { id: crypto.randomUUID(), type: 'system.hotkey', settings: { hotkey: null }, appearance: {} }])}
        >
          <Icon name="plus" size={14} /> Add step
        </button>
        <button type="button" className="secondary" onClick={() => onChange([...steps, { id: crypto.randomUUID(), type: 'sd.delay', settings: { ms: 250 }, appearance: {} }])}>
          <Icon name="timer" size={14} /> Add delay
        </button>
      </div>
    </div>
  );
}
