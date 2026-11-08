import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { DeviceSummary, Page, Profile } from '../../../src/shared/types.ts';
import { STARTER_LAYOUTS, type StarterLayout } from '../../../src/shared/starter-layouts.ts';
import { act, client, toast } from '../api.ts';
import { Icon } from './Icon.tsx';
import { ImageButton } from './Inspector.tsx';

export function PagesBar({ device, profile, editable }: { device: DeviceSummary; profile: Profile; editable: boolean }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const current = profile.pages[device.pageId];
  const rootId = device.stack[0] ?? device.pageId;
  const inFolder = !!current?.parentId;

  const rename = (id: string, name: string) => {
    setEditing(null);
    if (name.trim() && name !== profile.pages[id]?.name) void act('pages.rename', { profileId: profile.id, pageId: id, name: name.trim() });
  };

  return (
    <nav className="pages" aria-label="Pages">
      {inFolder ? (
        <div className="crumbs">
          <button className="secondary" onClick={() => act('session.back', { deviceId: device.id })}>
            <Icon name="corner-up-left" size={14} /> Back
          </button>
          {[...device.stack, device.pageId].map((id, i, arr) => (
            <span key={id} className="crumb">
              {i > 0 ? <Icon name="chevron-right" size={13} /> : null}
              <button className={i === arr.length - 1 ? 'here' : 'link'} aria-current={i === arr.length - 1 ? 'page' : undefined} onClick={() => act('session.setPage', { deviceId: device.id, pageId: id })}>
                {i > 0 ? <Icon name="folder" size={13} /> : null} {profile.pages[id]?.name}
              </button>
            </span>
          ))}
        </div>
      ) : (
        <ol className="page-tabs">
          {profile.pageOrder.map((id, i) => {
            const pg = profile.pages[id]!;
            const on = id === rootId;
            return (
              <li
                key={id}
                className={`page-tab ${on ? 'on' : ''} ${dragId === id ? 'dragging' : ''}`}
                draggable={editable && editing !== id}
                onDragStart={(e) => {
                  setDragId(id);
                  e.dataTransfer.setData('application/x-osb-page', id);
                }}
                onDragEnd={() => setDragId(null)}
                onDragOver={(e) => e.dataTransfer.types.includes('application/x-osb-page') && e.preventDefault()}
                onDrop={(e) => {
                  const from = e.dataTransfer.getData('application/x-osb-page');
                  if (!editable || !from || from === id) return;
                  const order = profile.pageOrder.filter((x) => x !== from);
                  order.splice(order.indexOf(id) + (profile.pageOrder.indexOf(from) < i ? 1 : 0), 0, from);
                  void act('pages.reorder', { profileId: profile.id, order });
                }}
              >
                {editable && editing === id ? (
                  <input
                    autoFocus
                    defaultValue={pg.name}
                    aria-label="Page name"
                    onBlur={(e) => rename(id, e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') rename(id, (e.target as HTMLInputElement).value);
                      if (e.key === 'Escape') setEditing(null);
                    }}
                  />
                ) : (
                  <button aria-current={on ? 'page' : undefined} onClick={() => act('session.setPage', { deviceId: device.id, pageId: id })}
                    onDoubleClick={editable ? () => setEditing(id) : undefined}
                    onKeyDown={editable ? (e) => { if (e.key === 'F2') { e.preventDefault(); setEditing(id); } } : undefined}
                    title={editable ? 'Double-click or press F2 to rename. Drag to reorder.' : undefined}>
                    <span className="page-n">{i + 1}</span> {pg.name}
                  </button>
                )}
              </li>
            );
          })}
          {editable && <li>
            <AddPageMenu device={device} profile={profile} />
          </li>}
        </ol>
      )}
      {editable && <div className="page-tools">
        {current && !inFolder ? (
          <>
            <button className="ghost icon-btn" title="Duplicate page" aria-label="Duplicate page" onClick={() => act('pages.duplicate', { profileId: profile.id, pageId: current.id })}>
              <Icon name="copy" size={15} />
            </button>
            <button
              className="ghost icon-btn"
              title="Delete page"
              aria-label="Delete page"
              disabled={profile.pageOrder.length <= 1}
              onClick={() => confirm(`Delete page “${current.name}” and everything on it?`) && act('pages.delete', { profileId: profile.id, pageId: current.id })}
            >
              <Icon name="trash-2" size={15} />
            </button>
          </>
        ) : null}
        {device.lcd && current ? (
          <>
            <ImageButton label="Touch strip background" onImage={(id) => act('pages.setTouchBg', { profileId: profile.id, pageId: current.id, imageId: id })} />
            {current.touchBg ? (
              <button className="ghost icon-btn" title="Remove strip background" aria-label="Remove strip background" onClick={() => act('pages.setTouchBg', { profileId: profile.id, pageId: current.id, imageId: null })}>
                <Icon name="image-off" size={15} />
              </button>
            ) : null}
          </>
        ) : null}
      </div>}
    </nav>
  );
}

async function addPresetPage(profileId: string, deviceId: string, layout: StarterLayout) {
  const pageId = await client.rpc<string>('pages.addStarter', { profileId, deviceId, layoutId: layout.id });
  toast(`${layout.name} page added`, 'info', { label: 'Undo', run: () => act('pages.delete', { profileId, pageId }) });
}

function AddPageMenu({ device, profile }: { device: DeviceSummary; profile: Profile }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ left: 0, top: 0 });
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => {
      const items = [...(root.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
      const at = items.indexOf(document.activeElement as HTMLElement);
      if (e.key === 'Escape') { setOpen(false); root.current?.querySelector<HTMLElement>('button')?.focus(); }
      else if (e.key === 'Tab') setOpen(false);
      else if (at >= 0 && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
        e.preventDefault();
        const n = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : (at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        items[n]?.focus();
      }
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', esc);
    requestAnimationFrame(() => root.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus());
    return () => { window.removeEventListener('mousedown', close); window.removeEventListener('keydown', esc); };
  }, [open]);
  const addStarter = async (layout: StarterLayout) => {
    setOpen(false);
    try {
      await addPresetPage(profile.id, device.id, layout);
    } catch (e) { toast((e as Error).message, 'error'); }
  };
  return (
    <div className="add-page" ref={root}>
      <button className="ghost icon-btn" aria-label="Add page" title="Add page" aria-haspopup="menu" aria-expanded={open} onClick={(e) => {
        // The tab strip scrolls horizontally, so the menu is positioned against the viewport.
        const r = e.currentTarget.getBoundingClientRect();
        setPos({ left: Math.max(8, Math.min(r.left, innerWidth - 308)), top: Math.min(r.bottom + 6, innerHeight - 380) });
        setOpen(!open);
      }}>
        <Icon name="plus" size={16} />
      </button>
      {open ? (
        <div className="menu add-page-menu" role="menu" aria-label="Add page" style={pos}>
          <button role="menuitem" className="menu-item" onClick={() => { setOpen(false); void act('pages.add', { profileId: profile.id, deviceId: device.id }); }}>
            <Icon name="file-plus" size={15} /><span className="grow"><b>Blank page</b></span>
          </button>
          <div className="menu-label">Start from a layout</div>
          {STARTER_LAYOUTS.map((l) => (
            <button key={l.id} role="menuitem" className="menu-item starter-item" style={{ '--accent': l.color } as CSSProperties} onClick={() => addStarter(l)}>
              <Icon name={l.icon} size={15} /><span className="grow"><b>{l.name}</b><small>{l.description}</small></span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function PresetButtonGroups({ profile, page, device, showHeading }: { profile: Profile; page: Page; device: DeviceSummary; showHeading: boolean }) {
  const empty = !page.keys.some(Boolean) && !page.dials.some(Boolean);
  const [applying, setApplying] = useState<string | null>(null);
  const apply = async (layout: StarterLayout) => {
    if (applying) return;
    setApplying(layout.id);
    try {
      if (!empty) {
        await addPresetPage(profile.id, device.id, layout);
        return;
      }
      const pageId = page.id;
      const r = await client.rpc<{ added: { kind: 'key' | 'dial'; index: number; id: string }[] }>('pages.fillStarter', { profileId: profile.id, pageId, layoutId: layout.id });
      if (r.added.length) {
        toast(`${layout.name} buttons added`, 'info', { label: 'Undo', run: () => Promise.all(r.added.map(a =>
          act('slots.clear', { profileId: profile.id, pageId, kind: a.kind, index: a.index, expectedActionId: a.id }))) });
      } else toast('No compatible buttons could be added to this page.');
    } catch (e) { toast((e as Error).message, 'error'); }
    finally { setApplying(null); }
  };
  return (
    <section className="studio-presets" aria-label="Preset button groups">
      {showHeading && <h2>Preset button groups</h2>}
      <p>{empty ? 'Fill this empty page with a set of ready-to-use buttons.' : 'Add a new page of buttons to this profile.'}</p>
      <div className="studio-preset-grid">
        {STARTER_LAYOUTS.map(l => (
          <button key={l.id} className="studio-preset" type="button" disabled={!!applying}
            onClick={() => void apply(l)} title={l.description}>
            <Icon name={l.icon} size={16} />
            <span>{applying === l.id ? 'Adding…' : l.name}</span>
            <Icon name="plus" size={13} />
          </button>
        ))}
      </div>
    </section>
  );
}
