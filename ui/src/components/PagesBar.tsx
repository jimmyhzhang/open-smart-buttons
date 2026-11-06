import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { DeviceSummary, Profile } from '../../../src/shared/types.ts';
import { STARTER_LAYOUTS } from '../../../src/shared/starter-layouts.ts';
import { act, client, toast } from '../api.ts';
import { Icon } from './Icon.tsx';
import { ImageButton } from './Inspector.tsx';

export function PagesBar({ device, profile }: { device: DeviceSummary; profile: Profile }) {
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
              <button className={i === arr.length - 1 ? 'here' : 'link'} onClick={() => act('session.setPage', { deviceId: device.id, pageId: id })}>
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
                draggable={editing !== id}
                onDragStart={(e) => {
                  setDragId(id);
                  e.dataTransfer.setData('application/x-sdp-page', id);
                }}
                onDragEnd={() => setDragId(null)}
                onDragOver={(e) => e.dataTransfer.types.includes('application/x-sdp-page') && e.preventDefault()}
                onDrop={(e) => {
                  const from = e.dataTransfer.getData('application/x-sdp-page');
                  if (!from || from === id) return;
                  const order = profile.pageOrder.filter((x) => x !== from);
                  order.splice(order.indexOf(id) + (profile.pageOrder.indexOf(from) < i ? 1 : 0), 0, from);
                  void act('pages.reorder', { profileId: profile.id, order });
                }}
              >
                {editing === id ? (
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
                  <button onClick={() => act('session.setPage', { deviceId: device.id, pageId: id })} onDoubleClick={() => setEditing(id)} title="Double-click to rename, drag to reorder">
                    <span className="page-n">{i + 1}</span> {pg.name}
                  </button>
                )}
              </li>
            );
          })}
          <li>
            <AddPageMenu device={device} profile={profile} />
          </li>
        </ol>
      )}
      <div className="page-tools">
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
      </div>
    </nav>
  );
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
  const addStarter = async (layoutId: string, name: string) => {
    setOpen(false);
    try {
      const pageId = await client.rpc<string>('pages.addStarter', { profileId: profile.id, deviceId: device.id, layoutId });
      toast(`${name} page added`, 'info', { label: 'Undo', run: () => act('pages.delete', { profileId: profile.id, pageId }) });
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
            <button key={l.id} role="menuitem" className="menu-item starter-item" style={{ '--accent': l.color } as CSSProperties} onClick={() => addStarter(l.id, l.name)}>
              <Icon name={l.icon} size={15} /><span className="grow"><b>{l.name}</b><small>{l.description}</small></span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** Shown under the device when the current page has nothing on it. */
export function EmptyPageStarter({ profile, pageId }: { profile: Profile; pageId: string }) {
  const fill = async (layoutId: string, name: string) => {
    try {
      const r = await client.rpc<{ added: { kind: 'key' | 'dial'; index: number; id: string }[] }>('pages.fillStarter', { profileId: profile.id, pageId, layoutId });
      toast(`${name} layout added`, 'info', { label: 'Undo', run: () => Promise.all(r.added.map((a) => client.rpc('slots.clear', { profileId: profile.id, pageId, kind: a.kind, index: a.index, expectedActionId: a.id }).catch(() => {}))) });
    } catch (e) { toast((e as Error).message, 'error'); }
  };
  return (
    <div className="empty-starter" role="group" aria-label="Fill this page from a layout">
      <span>Empty page — start with</span>
      {STARTER_LAYOUTS.map((l) => (
        <button key={l.id} className="starter-chip" style={{ '--accent': l.color } as CSSProperties} onClick={() => fill(l.id, l.name)} title={l.description}>
          <Icon name={l.icon} size={14} />{l.name}
        </button>
      ))}
    </div>
  );
}
