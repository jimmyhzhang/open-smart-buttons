import { isLocalAction } from '../../../src/shared/local-action-policy.ts';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { ActionMeta, Controller } from '../../../src/shared/types.ts';
import { ACTION_CATEGORIES, actionChoices, actionScore, matchesAction, type ActionCategory, type ActionChoice } from '../../../src/shared/action-presets.ts';
import { Icon } from './Icon.tsx';
import './Library.css';

const LABELS: Record<string, string> = {
  'system.open': 'Open an app or file',
  'system.hotkey': 'Send a keyboard shortcut',
  'system.script': 'Run a script',
};
const INTEGRATION_SUMMARIES: Record<string, string> = {
  'agent.codex': 'Start or continue a project session in Terminal.',
  'agent.claude': 'Start or continue a project session in Terminal.',
  'auto-shortcut': 'Choose from Apple Shortcuts.',
  'system.script': 'Choose an executable file.',
  'system.raycast': 'Paste a command link.',
  'system.asyar': 'Paste a command link.',
};

export function Library(props: {
  catalog: ActionMeta[];
  hasDials: boolean;
  localOnly?: boolean;
  onChoose(choice: ActionChoice): void;
  target?: { kind: Controller; index: number } | null;
}) {
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<ActionCategory | null>(null);
  const [active, setActive] = useState<number | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const targetKind = props.target?.kind;
  const choices = useMemo(() => {
    const catalog = props.catalog.filter(meta => targetKind
      ? meta.controllers.includes(targetKind)
      : props.hasDials || meta.controllers.includes('key'));
    return actionChoices(catalog).filter(choice => !props.localOnly || choice.type === 'sd.multi' ||
      isLocalAction({ type: choice.type, settings: { ...catalog.find(meta => meta.type === choice.type)?.defaults, ...choice.settings } }));
  }, [props.catalog, props.hasDials, props.localOnly, targetKind]);

  const query = search.trim();
  const categories = ACTION_CATEGORIES.filter(name => choices.some(choice => choice.category === name));
  const results = useMemo(() => {
    if (!query) return category ? choices.filter(choice => choice.category === category) : [];
    const normalized = query.toLowerCase();
    return choices.flatMap(choice => {
      const label = LABELS[choice.id];
      const searchable = label ? { ...choice, keywords: `${choice.keywords ?? ''} ${label}` } : choice;
      if (!matchesAction(searchable, query)) return [];
      const score = choice.name.toLowerCase() === normalized || label?.toLowerCase() === normalized
        ? 110 : actionScore(choice, query);
      return [{ choice, score }];
    }).sort((a, b) => b.score - a.score).map(({ choice }) => choice);
  }, [choices, query, category]);
  const selectedIndex = active ?? (query && results.length ? 0 : null);
  const highlighted = selectedIndex === null ? undefined : results[selectedIndex];

  useEffect(() => {
    if (active === null || !list.current) return;
    const item = list.current.querySelector(`[data-action-index="${active}"]`);
    if (!item) return;
    const viewport = list.current.getBoundingClientRect();
    const row = item.getBoundingClientRect();
    if (row.top < viewport.top) list.current.scrollTop += row.top - viewport.top;
    if (row.bottom > viewport.bottom) list.current.scrollTop += row.bottom - viewport.bottom;
  }, [active]);

  const changeSearch = (value: string) => {
    setSearch(value);
    setActive(null);
    if (list.current) list.current.scrollTop = 0;
  };

  const onSearchKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && results.length) {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActive(selectedIndex === null ? (step === 1 ? 0 : results.length - 1) : Math.max(0, Math.min(results.length - 1, selectedIndex + step)));
    } else if (event.key === 'Enter' && highlighted) {
      event.preventDefault();
      if (!event.repeat) props.onChoose(highlighted);
    } else if (event.key === 'Escape' && search) {
      event.preventDefault();
      event.stopPropagation();
      changeSearch('');
    }
  };

  return (
    <aside className="library action-library action-picker" aria-label="Action library">
      <header className="picker-header">
        <div className="picker-search">
          <Icon name="search" size={17} />
          <input id="action-search" ref={input} placeholder="Search all actions…" value={search}
            onChange={event => changeSearch(event.target.value)} onKeyDown={onSearchKey}
            aria-label="Search actions" aria-controls="action-results" aria-describedby="action-search-hint"
            autoComplete="off" spellCheck={false} />
          {search ? (
            <button className="picker-clear" type="button" aria-label="Clear search" onClick={() => { changeSearch(''); input.current?.focus({ preventScroll: true }); }}>
              <Icon name="x" size={15} />
            </button>
          ) : <kbd aria-hidden="true">⌘K</kbd>}
        </div>
        <span id="action-search-hint" className="sr">Use the up and down arrow keys to highlight an action, then press Enter to set it up.</span>
        {!query && (
          <div className="picker-types" role="group" aria-labelledby="picker-type-label">
            <h2 id="picker-type-label">Action type</h2>
            <div className="picker-views">
              {categories.map(name => <button key={name} type="button" aria-pressed={category === name}
                onClick={() => { setCategory(name); changeSearch(''); }}>{name}</button>)}
            </div>
          </div>
        )}
      </header>
      <div className="sr" aria-live="polite">
        {highlighted ? `${LABELS[highlighted.id] ?? highlighted.name}. Enter opens setup.`
          : query ? `${results.length} actions found.` : ''}
      </div>
      <div className="picker-results" id="action-results" ref={list}>
        {results.length ? (
          <section className="picker-section" aria-labelledby="picker-action-label">
            <h2 id="picker-action-label">{query ? `${results.length} result${results.length === 1 ? '' : 's'}` : 'Choose an action'}</h2>
            {results.map((choice, index) => (
              <button key={choice.id} type="button" data-action-index={index}
                data-highlighted={selectedIndex === index || undefined} className="picker-item" draggable
                onClick={() => props.onChoose(choice)}
                onDragStart={event => {
                  event.dataTransfer.setData('application/x-sdp-action', choice.type);
                  event.dataTransfer.setData('application/x-sdp-preset', choice.id);
                  event.dataTransfer.effectAllowed = 'copy';
                }}>
                <span className="picker-icon"><Icon name={choice.icon} size={18} /></span>
                <span className="picker-item-text">
                  <strong>{LABELS[choice.id] ?? choice.name}</strong>
                  <span>{choice.note ?? INTEGRATION_SUMMARIES[choice.id] ?? choice.description}</span>
                </span>
                <Icon name="chevron-right" size={15} />
                {selectedIndex === index && <kbd className="picker-return" aria-hidden="true">↩</kbd>}
              </button>
            ))}
          </section>
        ) : query ? (
          <div className="picker-empty">
            <Icon name="search" size={22} />
            <strong>No matching actions</strong>
            <p>Try an app name, “mute”, or “screenshot”.</p>
          </div>
        ) : (
          <p className="picker-hint">{categories.length ? 'Pick a type to see actions, or search by name.' : 'Select a key to see key actions.'}</p>
        )}
      </div>
    </aside>
  );
}
