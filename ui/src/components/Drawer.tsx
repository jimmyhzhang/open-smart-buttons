import { useCallback, useEffect, useRef, useState } from 'react';
import { client, useLogs } from '../api.ts';
import { isNative, useMenuCommand } from '../native.ts';

// The app avoids protocol jargon; the browser editor keeps its developer wording.
const trafficLabel = isNative ? 'USB traffic' : 'HID traffic';
import { Icon } from './Icon.tsx';

export function Drawer() {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'activity' | 'hid'>('activity');
  const [paused, setPaused] = useState(false);
  const { logs, hid } = useLogs();
  const list = useRef<HTMLDivElement>(null);
  const frozen = useRef<typeof hid>([]);
  useMenuCommand('activity.toggle', useCallback(() => setOpen((o) => !o), []));

  useEffect(() => {
    client.setHid(open && tab === 'hid' && !paused);
  }, [open, tab, paused]);
  useEffect(() => {
    if (!paused) frozen.current = hid;
  }, [hid, paused]);
  useEffect(() => {
    const el = list.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logs.length, hid.length, tab, open]);

  const errors = logs.filter((l) => l.level === 'error').length;
  const rows = paused ? frozen.current : hid;

  return (
    <section className={`drawer ${open ? 'open' : ''}`} aria-label={`Activity and ${trafficLabel}`}>
      <div className="drawer-bar">
        <button className="ghost" onClick={() => setOpen(!open)} aria-expanded={open}>
          <Icon name={open ? 'chevron-down' : 'chevron-up'} size={14} />
          {isNative || !logs.length ? 'Activity' : logs[logs.length - 1]!.msg}
        </button>
        {errors ? <span className="err-count">{errors} errors</span> : null}
        <div className="spacer" />
        {open ? (
          <div className="seg small">
            <button className={tab === 'activity' ? 'on' : ''} onClick={() => setTab('activity')}>
              Activity
            </button>
            <button className={tab === 'hid' ? 'on' : ''} onClick={() => setTab('hid')}>
              {trafficLabel}
            </button>
          </div>
        ) : null}
        {open && tab === 'hid' ? (
          <button className="ghost" onClick={() => setPaused(!paused)}>
            <Icon name={paused ? 'play' : 'pause'} size={14} /> {paused ? 'Resume' : 'Pause'}
          </button>
        ) : null}
      </div>
      {open ? (
        <div className="drawer-body" ref={list}>
          {tab === 'activity'
            ? logs.map((l, i) => (
                <div key={i} className={`log ${l.level}`}>
                  <time>{new Date(l.t).toLocaleTimeString()}</time>
                  <span>{l.msg}</span>
                </div>
              ))
            : rows.map((e, i) => (
                <div key={i} className={`hid ${e.dir}`}>
                  <time>{new Date(e.t).toLocaleTimeString(undefined, { hour12: false })}.{String(e.t % 1000).padStart(3, '0')}</time>
                  <span className="dir">{e.dir === 'in' ? '← in' : e.dir === 'out' ? '→ out' : '→ feat'}</span>
                  <span className="sum">{e.summary}</span>
                  <code>{e.hex}</code>
                </div>
              ))}
          {tab === 'hid' && !rows.length ? <p className="muted pad">Reports appear here as they cross the wire. Press a key or turn a dial.</p> : null}
          {tab === 'activity' && !logs.length ? <p className="muted pad">Action results and device events show up here.</p> : null}
        </div>
      ) : null}
    </section>
  );
}
