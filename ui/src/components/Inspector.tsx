import { PrivateImage } from './PrivateImage';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ActionInstance, ActionMeta, Appearance, IconRef, Profile } from '../../../src/shared/types.ts';
import { act, client, toast, useFrames } from '../api.ts';
import { DebouncedInput } from './Fields.tsx';
import { actionSummary } from '../../../src/shared/action-setup.ts';
import { Icon } from './Icon.tsx';
import type { Slot } from './DeviceView.tsx';
import { MAX_STATE_RULES, STATE_OPS, STATE_SOURCES, STATE_SOURCE_MAP, ruleMatches, stateKey, validateStateRules, type StateReading, type StateRule, type StateSourceId } from '../../../src/shared/state-rules.ts';

interface Props {
  deviceId: string;
  profile: Profile;
  profiles: Profile[];
  pageId: string;
  slot: Slot | null;
  instance: ActionInstance | null | undefined;
  catalog: Map<string, ActionMeta>;
  onOpenFolder(id: string): void;
  onBrowseActions(): void;
  onRemove(): void;
  onConfigure(): void;
}

export function Inspector(p: Props) {
  const frames = useFrames(p.deviceId);
  if (!p.slot) {
    return (
      <section className="inspector empty-state">
        <div><Icon name="mouse-pointer-2" size={24} /><h2>Every button starts with an idea.</h2><p>Select a key to edit, or choose a workflow from the action library.</p><button className="secondary" onClick={p.onBrowseActions}>Browse actions <Icon name="arrow-right" size={14} /></button></div>
      </section>
    );
  }
  const where = p.slot.kind === 'key' ? `Key ${p.slot.index + 1}` : `Dial ${p.slot.index + 1}`;
  if (!p.instance) {
    return (
      <section className="inspector empty-state">
        <div><Icon name="plus" size={26} /><h2>What should {where.toLowerCase()} do?</h2><p>Launch an agent, run a script, or give an everyday task its own button.</p><button className="primary" onClick={p.onBrowseActions}>Choose an action <Icon name="arrow-right" size={14} /></button></div>
      </section>
    );
  }
  const inst = p.instance;
  const meta = p.catalog.get(inst.type);
  const base = { profileId: p.profile.id, pageId: p.pageId, kind: p.slot.kind, index: p.slot.index };
  const update = (patch: { settings?: Record<string, unknown>; appearance?: Partial<Appearance> }) => act('slots.update', { ...base, ...patch });
  const preview = p.slot.kind === 'key' ? frames?.keys[p.slot.index] : null;
  const missing = meta?.fields.find((f) => f.required && (!f.controllers || f.controllers.includes(p.slot!.kind)) && !String(inst.settings[f.key] ?? '').trim());

  return (
    <section className="inspector" aria-label={`${where} settings`}>
      <header className="insp-head">
        <div className="insp-preview">
          {preview ? <img src={`data:image/jpeg;base64,${preview}`} alt="" /> : <span style={{ color: meta?.color }}><Icon name={meta?.icon ?? 'puzzle'} size={26} /></span>}
        </div>
        <div className="insp-title">
          <h2>{inst.appearance.title?.replace(/\s+/g, ' ').trim() || meta?.name || inst.type}</h2>
          <p>
            {where} · {meta?.name ?? inst.type}
          </p>
          {inst.type === 'unsupported' ? <p className="warn">Imported from Elgato plugin {String(inst.settings.elgatoUUID)}. It shows its icon but doesn't run yet.</p> : null}
        </div>
        <div className="insp-actions">
          <button className="secondary" onClick={() => act('slots.test', { deviceId: p.deviceId, kind: p.slot!.kind, index: p.slot!.index })}>
            <Icon name="play" size={14} /> Test
          </button>
          {p.slot.kind === 'key' ? <button className="ghost" title="Copy to the next empty key" onClick={async () => {
            const keys = p.profile.pages[p.pageId]?.keys ?? [];
            const after = keys.findIndex((k, i) => !k && i > p.slot!.index);
            const target = after >= 0 ? after : keys.findIndex((k) => !k);
            if (target < 0) { toast('No empty key on this page'); return; }
            try {
              await client.rpc('slots.move', { profileId: p.profile.id, from: { pageId: p.pageId, kind: 'key', index: p.slot!.index }, to: { pageId: p.pageId, kind: 'key', index: target }, copy: true, expectEmpty: true });
              toast(`Duplicated to Key ${target + 1}`);
            } catch (e) { toast((e as Error).message, 'error'); }
          }}>
            <Icon name="copy-plus" size={14} /> Duplicate
          </button> : null}
          <button className="ghost danger" onClick={p.onRemove}>
            <Icon name="trash-2" size={14} /> Remove
          </button>
        </div>
      </header>
      <div className="insp-body">
        {meta && meta.category !== 'Hidden' ? <div className="insp-col action-overview"><h3>{p.slot.kind === 'dial' ? 'When used' : 'When pressed'}</h3>{missing ? <p className="setup-missing" role="status"><Icon name="triangle-alert" size={14} />Not set up yet — choose {missing.label.toLowerCase()} to make this button work.</p> : <p>{actionSummary(meta, inst.settings, p.slot.kind)}</p>}<button className="primary" onClick={p.onConfigure}><Icon name="sliders-horizontal" size={15} />Configure action</button>{inst.type === 'sd.folder' && inst.settings.folderId ? <button className="secondary" onClick={() => p.onOpenFolder(String(inst.settings.folderId))}><Icon name="folder-open" size={15} />Open folder</button> : null}</div> : null}
        <div className="insp-col">
          <h3>Look</h3>
          <AppearanceEditor key={inst.id} ap={inst.appearance} meta={meta} kind={p.slot.kind} onChange={(ap) => update({ appearance: ap })} />
        </div>
        <div className="insp-col state-rules">
          <h3>Changes with your Mac</h3>
          <StateRulesEditor key={inst.id} deviceId={p.deviceId} rules={inst.stateRules ?? []} onSave={(stateRules) => act('slots.update', { ...base, stateRules })} />
        </div>
      </div>
    </section>
  );
}

const BG_PRESETS = ['#000000', '#0f172a', '#163456', '#2c2350', '#3f2235', '#10443d', '#4a301e', '#7f1d1d'];

function AppearanceEditor({ ap, meta, kind, onChange }: { ap: Appearance; meta?: ActionMeta; kind: 'key' | 'dial'; onChange(a: Partial<Appearance>): void }) {
  const [picker, setPicker] = useState(false);
  const icon = ap.icon;
  return (
    <div className="fields">
      <div className="field">
        <label htmlFor="ap-title">Title</label>
        <DebouncedInput id="ap-title" value={ap.title ?? ''} placeholder={meta?.name} onChange={(v) => onChange({ title: v })} multiline={kind === 'key'} />
      </div>
      {kind === 'key' ? (
        <div className="field row">
          <div className="seg" role="radiogroup" aria-label="Title position">
            {(['top', 'middle', 'bottom'] as const).map((a) => (
              <button key={a} role="radio" aria-checked={(ap.titleAlign ?? 'bottom') === a} className={(ap.titleAlign ?? 'bottom') === a ? 'on' : ''} onClick={() => onChange({ titleAlign: a })}>
                {a === 'top' ? 'Top' : a === 'middle' ? 'Middle' : 'Bottom'}
              </button>
            ))}
          </div>
          <label className="mini">
            Size
            <input type="number" min={9} max={40} value={ap.titleSize ?? 15} onChange={(e) => onChange({ titleSize: Number(e.target.value) })} />
          </label>
          <label className="swatch" title="Title color">
            <input type="color" value={ap.titleColor ?? '#ffffff'} onChange={(e) => onChange({ titleColor: e.target.value })} aria-label="Title color" />
          </label>
          <label className="check compact">
            <input type="checkbox" checked={ap.showTitle !== false} onChange={(e) => onChange({ showTitle: e.target.checked })} />
            <span>Show</span>
          </label>
        </div>
      ) : null}
      <div className="field">
        <label>Icon and background</label>
        <div className="row">
          <button className="icon-well" onClick={() => setPicker(!picker)} aria-expanded={picker} aria-label="Change icon" title={icon ? 'Change icon' : 'Automatic icon (follows the action, e.g. muted). Click to pick your own.'}>
            <IconPreview icon={icon} fallback={meta?.icon} color={ap.iconColor} />
            {!icon ? <span className="auto-badge">Auto</span> : null}
          </button>
          <label className="swatch" title="Icon color">
            <input type="color" value={ap.iconColor ?? '#ffffff'} onChange={(e) => onChange({ iconColor: e.target.value })} aria-label="Icon color" />
          </label>
          <label className="swatch bg" title="Custom background color">
            <input type="color" value={ap.bg ?? '#000000'} onChange={(e) => onChange({ bg: e.target.value })} aria-label="Background color" />
          </label>
          <div className="bg-swatches" role="group" aria-label="Background presets">
            {BG_PRESETS.map((c) => <button key={c} type="button" className={(ap.bg ?? '#000000').toLowerCase() === c ? 'on' : ''} style={{ background: c }} aria-label={`Background ${c}`} aria-pressed={(ap.bg ?? '#000000').toLowerCase() === c} onClick={() => onChange({ bg: c })} />)}
          </div>
          <ImageButton label="Background image" onImage={(id) => onChange({ bgImage: id })} />
          {ap.bgImage || ap.bg || ap.iconColor || icon ? (
            <button className="ghost" title="Back to the automatic icon and default colors" onClick={() => onChange({ bg: null, bgImage: null, iconColor: null, icon: null } as unknown as Partial<Appearance>)}>
              Reset
            </button>
          ) : null}
        </div>
      </div>
      {picker ? (
        <IconPicker
          current={icon}
          onPick={(i) => {
            onChange({ icon: i ?? null } as unknown as Partial<Appearance>);
            setPicker(false);
          }}
          onClose={() => setPicker(false)}
        />
      ) : null}
    </div>
  );
}

function IconPreview({ icon, fallback, color }: { icon?: IconRef; fallback?: string; color?: string }) {
  if (icon?.kind === 'image') return <PrivateImage id={icon.id} />;
  if (icon?.kind === 'emoji') return <span className="emoji">{icon.char}</span>;
  if (icon?.kind === 'none') return <span className="muted">None</span>;
  return (
    <span style={{ color: color ?? '#fff' }}>
      <Icon name={icon?.kind === 'lucide' ? icon.name : (fallback ?? 'square')} size={26} />
    </span>
  );
}

export function ImageButton({ label, onImage }: { label: string; onImage(id: string): void }) {
  return (
    <label className="ghost file-btn" title={label}>
      <Icon name="image-plus" size={16} />
      <span className="sr">{label}</span>
      <input
        type="file"
        accept="image/png,image/jpeg"
        onChange={async (e) => {
          const f = e.target.files?.[0];
          if (!f) return;
          const id = await uploadImage(f);
          if (id) onImage(id);
          e.target.value = '';
        }}
      />
    </label>
  );
}

export async function uploadImage(f: File): Promise<string | undefined> {
  const buf = new Uint8Array(await f.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return act<string>('images.upload', { base64: btoa(bin), ext: f.name.split('.').pop() ?? 'png' });
}

let lucideIndex: Promise<Record<string, string[]>> | null = null;
const EMOJI = '🎮 🎧 🎤 🎬 📷 💡 🔥 ⭐ ✅ ❌ 🚀 💬 📞 🔔 🔕 🔒 🔓 ⏯️ ⏭️ ⏮️ 🔊 🔇 ☕ 🍕 🎵 🎨 📝 📁 💻 🖥️ ⌨️ 🖱️ 🧠 🤖 🛠️ ⚙️ 🌙 ☀️ 🌈 ❤️ 👍 👋 😂 🎉 🏁'.split(' ');

function IconPicker({ onPick, onClose, current, autoTitle = "Automatic (follows the action's state)" }: { onPick(i: IconRef | null): void; onClose(): void; current?: IconRef; autoTitle?: string }) {
  const [tab, setTab] = useState<'icons' | 'emoji' | 'image'>('icons');
  const [q, setQ] = useState('');
  const [index, setIndex] = useState<Record<string, string[]> | null>(null);
  const box = useRef<HTMLDivElement>(null);
  // Braces matter: newer browsers return a Promise from scrollIntoView, and React would
  // treat any returned value as the effect's cleanup function.
  useEffect(() => { void box.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }, []);
  useEffect(() => {
    lucideIndex ??= fetch('/api/lucide/index.json').then((r) => r.json());
    void lucideIndex.then(setIndex);
  }, []);
  const names = useMemo(() => {
    if (!index) return [];
    const ql = q.trim().toLowerCase();
    const all = Object.keys(index);
    const hits = ql ? all.filter((n) => n.includes(ql) || index[n]!.some((t) => t.includes(ql))) : all;
    return hits.slice(0, 240);
  }, [index, q]);
  return (
    <div ref={box} className="picker" role="dialog" aria-label="Choose an icon">
      <div className="picker-head">
        <div className="seg small">
          {(['icons', 'emoji', 'image'] as const).map((t) => (
            <button key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
              {t === 'icons' ? 'Icons' : t === 'emoji' ? 'Emoji' : 'Image'}
            </button>
          ))}
        </div>
        {tab === 'icons' ? <input className="search" autoFocus placeholder="Search 2,000+ icons" value={q} onChange={(e) => setQ(e.target.value)} /> : null}
        <button className="ghost icon-btn" aria-label="Close" onClick={onClose}>
          <Icon name="x" size={16} />
        </button>
      </div>
      {tab === 'icons' ? (
        <div className="picker-grid">
          <button title={autoTitle} className={!current ? 'on' : ''} onClick={() => onPick(null)}>
            <span className="auto-cell">Auto</span>
          </button>
          {names.map((n) => (
            <button key={n} title={n} className={current?.kind === 'lucide' && current.name === n ? 'on' : ''} onClick={() => onPick({ kind: 'lucide', name: n })}>
              <Icon name={n} size={22} />
            </button>
          ))}
          <button title="No icon" onClick={() => onPick({ kind: 'none' })}>
            <Icon name="ban" size={22} />
          </button>
        </div>
      ) : tab === 'emoji' ? (
        <div className="picker-grid emoji">
          {EMOJI.map((e) => (
            <button key={e} onClick={() => onPick({ kind: 'emoji', char: e })}>
              {e}
            </button>
          ))}
        </div>
      ) : (
        <div className="picker-upload">
          <p>PNG, JPEG, GIF (first frame), WebP or SVG. Square images look best; they're scaled to fit the key.</p>
          <label className="secondary file-btn wide">
            <Icon name="upload" size={16} /> Choose an image
            <input
              type="file"
              accept="image/png,image/jpeg"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                const id = await uploadImage(f);
                if (id) onPick({ kind: 'image', id });
              }}
            />
          </label>
        </div>
      )}
    </div>
  );
}

const DEFAULT_VALUE: Record<string, StateRule['value']> = { number: 0, boolean: true, text: '' };

function formatReading(source: StateSourceId, r: StateReading | null | undefined): string {
  if (!r) return 'Reading…';
  if (r.value === undefined) return r.error ? `Can't read: ${r.error}` : 'Unknown';
  if (typeof r.value === 'boolean') return r.value ? 'Yes' : 'No';
  return `${String(r.value)}${STATE_SOURCE_MAP.get(source)?.unit ?? ''}`;
}

/** Rules that change this button's look with the computer's state. Saved whenever the list is valid. */
function StateRulesEditor({ rules: saved, deviceId, onSave }: { rules: StateRule[]; deviceId: string; onSave(rules: StateRule[]): unknown }) {
  const [rules, setRules] = useState<StateRule[]>(() => structuredClone(saved));
  const [picker, setPicker] = useState<number | null>(null);
  const [readings, setReadings] = useState<Record<string, StateReading | null>>({});
  const errors = validateStateRules(rules);
  const keys = [...new Set(rules.filter((r) => !STATE_SOURCE_MAP.get(r.source)?.arg || r.arg?.trim()).map(stateKey))];
  const keyList = keys.join('|');
  useEffect(() => {
    if (!keys.length) return;
    let live = true;
    const read = () => client.rpc<Record<string, StateReading | null>>('states.read', { keys, deviceId }).then((r) => live && setReadings(r)).catch(() => {});
    void read();
    const t = window.setInterval(read, 2000);
    return () => { live = false; clearInterval(t); };
  }, [keyList, deviceId]);
  const commit = (next: StateRule[]) => {
    setRules(next);
    if (!validateStateRules(next).length) void onSave(next);
  };
  const patch = (i: number, p: Partial<StateRule>) => {
    const next = rules.map((r, j) => {
      if (j !== i) return r;
      const merged: Record<string, unknown> = { ...r, ...p };
      for (const [k, v] of Object.entries(p)) if (v === undefined) delete merged[k];
      return merged as unknown as StateRule;
    });
    commit(next);
  };
  const setSource = (i: number, source: StateSourceId) => {
    const meta = STATE_SOURCE_MAP.get(source)!;
    patch(i, { source, op: STATE_OPS[meta.kind][0]!.value, value: DEFAULT_VALUE[meta.kind]!, arg: meta.arg ? (rules[i]!.arg ?? '') : undefined });
  };
  const active = rules.findIndex((r) => ruleMatches(r, readings[stateKey(r)]?.value));
  return (
    <div className="fields">
      <p className="help">Show a different icon, background or title while something is true. The first matching rule wins; otherwise the button keeps its normal look. Checked about once a second while the button is on screen.</p>
      {rules.map((r, i) => {
        const meta = STATE_SOURCE_MAP.get(r.source);
        const reading = readings[stateKey(r)];
        return (
          <div key={i} className={`state-rule${i === active ? ' on' : ''}`} aria-label={`Rule ${i + 1}`}>
            <div className="row">
              <span className="state-word">When</span>
              <select aria-label="State" value={r.source} onChange={(e) => setSource(i, e.target.value as StateSourceId)}>
                {STATE_SOURCES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
              </select>
              {meta?.arg ? <DebouncedInput ariaLabel={meta.arg.label} list="installed-apps" value={r.arg ?? ''} placeholder={meta.arg.placeholder} onChange={(v) => patch(i, { arg: v })} /> : null}
              {meta?.kind === 'boolean' ? (
                <div className="seg small" role="radiogroup" aria-label="Value">
                  {[true, false].map((v) => <button key={String(v)} role="radio" aria-checked={r.value === v} className={r.value === v ? 'on' : ''} onClick={() => patch(i, { value: v })}>{v ? 'Yes' : 'No'}</button>)}
                </div>
              ) : (
                <>
                  <select aria-label="Comparison" className="state-op" value={r.op} onChange={(e) => patch(i, { op: e.target.value as StateRule['op'] })}>
                    {STATE_OPS[meta?.kind ?? 'text'].map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                  {meta?.kind === 'number'
                    ? <input type="number" aria-label="Value" className="state-num" value={Number(r.value)} onChange={(e) => patch(i, { value: Number(e.target.value) })} />
                    : <DebouncedInput ariaLabel="Value" value={String(r.value)} placeholder="Finder" onChange={(v) => patch(i, { value: v })} />}
                </>
              )}
            </div>
            <div className="row">
              <span className="state-word">Show</span>
              <button className="icon-well small" onClick={() => setPicker(picker === i ? null : i)} aria-expanded={picker === i} aria-label="Icon while this is true" title="Icon while this is true">
                {r.icon ? <IconPreview icon={r.icon} /> : <span className="auto-cell">Same</span>}
              </button>
              <label className="swatch bg" title="Background while this is true">
                <input type="color" value={r.bg ?? '#000000'} onChange={(e) => patch(i, { bg: e.target.value })} aria-label="Background while this is true" />
              </label>
              {r.bg ? <button className="ghost icon-btn" title="Keep the normal background" aria-label="Keep the normal background" onClick={() => patch(i, { bg: undefined })}><Icon name="x" size={13} /></button> : null}
              <DebouncedInput ariaLabel="Title while this is true" value={r.title ?? ''} placeholder="Same title" onChange={(v) => patch(i, { title: v || undefined })} />
              <button className="ghost icon-btn" disabled={i === 0} title="Check this rule first" aria-label="Move up" onClick={() => commit([...rules.slice(0, i - 1), r, rules[i - 1]!, ...rules.slice(i + 1)])}><Icon name="arrow-up" size={14} /></button>
              <button className="ghost icon-btn danger" title="Remove rule" aria-label="Remove rule" onClick={() => { setPicker(null); commit(rules.filter((_, j) => j !== i)); }}><Icon name="trash-2" size={14} /></button>
            </div>
            <p className="help state-now">Now: {formatReading(r.source, reading)}{i === active ? <strong> · showing</strong> : null}</p>
            {picker === i ? <IconPicker current={r.icon} autoTitle="Keep the normal icon" onPick={(icon) => { patch(i, { icon: icon ?? undefined }); setPicker(null); }} onClose={() => setPicker(null)} /> : null}
          </div>
        );
      })}
      {errors.length && rules.length ? <p className="setup-missing" role="status"><Icon name="triangle-alert" size={14} />{errors[0]} — not saved yet.</p> : null}
      {rules.length < MAX_STATE_RULES ? (
        <button className="secondary" onClick={() => commit([...rules, { source: 'muted', op: 'is', value: true, icon: { kind: 'lucide', name: 'volume-x' } }])}>
          <Icon name="plus" size={14} /> Add state rule
        </button>
      ) : null}
    </div>
  );
}
