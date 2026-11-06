import { isLocalAction } from '../../../src/shared/local-action-policy.ts';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { ActionMeta, Controller } from '../../../src/shared/types.ts';
import { ACTION_CATEGORIES, actionChoices, actionScore, matchesAction, type ActionCategory, type ActionChoice } from '../../../src/shared/action-presets.ts';
import { Icon } from './Icon.tsx';
import './Library.css';

const RECENT_KEY = 'sdp.recentActions';
const STARTERS = ['system.open', 'system.hotkey', 'snip-custom', 'media-mute'];
const TERMINAL_AGENTS = ['agent.codex', 'agent.claude'];
const INTEGRATIONS = ['auto-shortcut', 'system.script', 'system.raycast', 'system.asyar'];
const LABELS: Record<string, string> = {
  'system.open': 'Open an app or file',
  'system.hotkey': 'Send a keyboard shortcut',
  'system.script': 'Run a script',
};
const INTEGRATION_SUMMARIES: Record<string, string> = {
  'agent.codex': 'Start or continue a project session.',
  'agent.claude': 'Start or continue a project session.',
  'auto-shortcut': 'Choose from Apple Shortcuts.',
  'system.script': 'Choose an executable file.',
  'system.raycast': 'Paste a command link.',
  'system.asyar': 'Paste a command link.',
};
const VIEWS = [
  { id: 'suggested', label: 'Suggested' },
  { id: 'integrations', label: 'Integrations' },
  { id: 'all', label: 'Browse all' },
] as const;
type View = typeof VIEWS[number]['id'];
type Category = 'All' | ActionCategory;

function readRecent(): string[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(saved) ? saved.filter((id): id is string => typeof id === 'string').slice(0, 6) : [];
  } catch {
    return [];
  }
}

function writeRecent(ids: string[]) {
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(ids)); }
  catch { /* History is optional when storage is unavailable. */ }
}

export interface ChooseOptions { customize?: boolean }

export function Library(props: {
  catalog: ActionMeta[];
  hasDials: boolean;
  localOnly?: boolean;
  onChoose(choice: ActionChoice, opts?: ChooseOptions): void;
  isQuick(choice: ActionChoice): boolean;
  target?: { kind: Controller; index: number } | null;
}) {
  const [search, setSearch] = useState('');
  const [view, setView] = useState<View>('suggested');
  const [category, setCategory] = useState<Category>('All');
  const [active, setActive] = useState<number | null>(null);
  const [recent, setRecent] = useState(readRecent);
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
  const categories = useMemo(() => ACTION_CATEGORIES.filter(name => choices.some(choice => choice.category === name)), [choices]);
  const selectedCategory = category !== 'All' && categories.includes(category) ? category : 'All';
  const sections = useMemo(() => {
    const byId = new Map(choices.map(choice => [choice.id, choice]));
    const get = (ids: string[]) => ids.flatMap(id => {
      const choice = byId.get(id);
      return choice ? [choice] : [];
    });

    if (query) {
      const normalized = query.toLowerCase();
      const matches = choices.filter(choice => {
        const label = LABELS[choice.id];
        return matchesAction(label ? { ...choice, keywords: `${choice.keywords ?? ''} ${label}` } : choice, query);
      });
      const score = (choice: ActionChoice) => {
        const name = choice.name.toLowerCase();
        const label = LABELS[choice.id]?.toLowerCase();
        return name === normalized || label === normalized ? 110 : actionScore(choice, query);
      };
      matches.sort((a, b) => score(b) - score(a));
      return [{ title: `${matches.length} result${matches.length === 1 ? '' : 's'}`, items: matches }];
    }
    if (view === 'integrations') {
      return [
        { title: 'Coding agents · open in Terminal', items: get(TERMINAL_AGENTS) },
        { title: 'Run a tool or automation', items: get(INTEGRATIONS) },
      ].filter(section => section.items.length);
    }
    if (view === 'all') {
      return categories.filter(name => selectedCategory === 'All' || name === selectedCategory)
        .map(name => ({ title: name, items: choices.filter(choice => choice.category === name) }));
    }
    const previous = get(recent).slice(0, 3);
    const starters = get(STARTERS).filter(choice => !previous.includes(choice));
    return [
      { title: 'Recent choices', items: previous },
      { title: 'Start here', items: starters.length || previous.length ? starters : choices.slice(0, 4) },
    ].filter(section => section.items.length);
  }, [choices, query, view, categories, selectedCategory, recent]);

  const results = sections.flatMap(section => section.items);
  const selectedIndex = active ?? (query && results.length ? 0 : null);
  const highlighted = selectedIndex === null ? undefined : results[selectedIndex];

  useEffect(() => {
    if (active !== null) list.current?.querySelector(`[data-action-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const changeSearch = (value: string) => {
    setSearch(value);
    setActive(null);
    if (list.current) list.current.scrollTop = 0;
  };

  const showView = (next: View) => {
    setView(next);
    setCategory('All');
    changeSearch('');
  };

  const choose = (choice: ActionChoice, customize = false) => {
    const next = [choice.id, ...recent.filter(id => id !== choice.id)].slice(0, 6);
    setRecent(next);
    writeRecent(next);
    setActive(null);
    props.onChoose(choice, { customize });
  };

  const onSearchKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.metaKey || event.ctrlKey || event.shiftKey) return;
    if (!event.altKey && (event.key === 'ArrowDown' || event.key === 'ArrowUp') && results.length) {
      event.preventDefault();
      if (selectedIndex === null) setActive(event.key === 'ArrowDown' ? 0 : results.length - 1);
      else setActive(Math.max(0, Math.min(results.length - 1, selectedIndex + (event.key === 'ArrowDown' ? 1 : -1))));
    } else if (event.key === 'Enter' && highlighted) {
      event.preventDefault();
      if (!event.repeat) choose(highlighted, event.altKey);
    } else if (event.key === 'Escape' && search) {
      event.preventDefault();
      event.stopPropagation();
      changeSearch('');
    }
  };

  let nextIndex = 0;
  return (
    <aside className="library action-library action-picker" aria-label="Action library">
      <header className="picker-header">
        <div className="picker-search">
          <Icon name="search" size={17} />
          <input
            id="action-search"
            ref={input}
            placeholder="Search actions…"
            value={search}
            onChange={event => changeSearch(event.target.value)}
            onKeyDown={onSearchKey}
            aria-label="Search actions"
            aria-controls="action-results"
            aria-describedby="action-search-hint"
            autoComplete="off"
            spellCheck={false}
          />
          {search ? (
            <button className="picker-clear" type="button" aria-label="Clear search" onClick={() => { changeSearch(''); input.current?.focus(); }}>
              <Icon name="x" size={15} />
            </button>
          ) : <kbd aria-hidden="true">⌘K</kbd>}
        </div>
        <span id="action-search-hint" className="sr">Use the up and down arrow keys to highlight an action, then press Enter.</span>
        {!query && (
          <div className="picker-views" role="group" aria-label="Browse actions">
            {VIEWS.map(item => <button key={item.id} type="button" aria-pressed={view === item.id} onClick={() => showView(item.id)}>{item.label}</button>)}
          </div>
        )}
        {!query && view === 'all' && (
          <label className="picker-filter">
            <span>Category</span>
            <select value={selectedCategory} onChange={event => { setCategory(event.target.value as Category); setActive(null); if (list.current) list.current.scrollTop = 0; }}>
              {['All', ...categories].map(name => <option key={name}>{name}</option>)}
            </select>
          </label>
        )}
      </header>
      <div className="sr" aria-live="polite">
        {highlighted
          ? `${LABELS[highlighted.id] ?? highlighted.name}. ${props.isQuick(highlighted) ? 'Enter adds it' : 'Enter opens setup'}.`
          : query ? `${results.length} actions found.` : ''}
      </div>
      <div className="picker-results" id="action-results" ref={list}>
        {results.length ? sections.map(section => (
          <section className="picker-section" key={section.title}>
            <h3>{section.title}</h3>
            {section.items.map(choice => {
              const index = nextIndex++;
              const quick = props.isQuick(choice);
              const name = LABELS[choice.id] ?? choice.name;
              return (
                <button
                  key={choice.id}
                  type="button"
                  data-action-index={index}
                  data-highlighted={selectedIndex === index || undefined}
                  className="picker-item"
                  draggable
                  title={quick ? 'Option-click to customize before adding' : undefined}
                  onClick={event => choose(choice, event.altKey)}
                  onDragStart={event => {
                    event.dataTransfer.setData('application/x-sdp-action', choice.type);
                    event.dataTransfer.setData('application/x-sdp-preset', choice.id);
                    event.dataTransfer.effectAllowed = 'copy';
                  }}
                >
                  <span className="picker-icon"><Icon name={choice.icon} size={18} /></span>
                  <span className="picker-item-text">
                    <strong>{name}</strong>
                    <span>{choice.note ?? INTEGRATION_SUMMARIES[choice.id] ?? choice.description}</span>
                  </span>
                  <span className="picker-item-verb">{quick ? 'Add' : 'Set up'}<Icon name={quick ? 'plus' : 'chevron-right'} size={13} /></span>
                  {selectedIndex === index && <kbd className="picker-return" aria-hidden="true">↩</kbd>}
                </button>
              );
            })}
          </section>
        )) : (
          <div className="picker-empty">
            <Icon name={query ? 'search' : 'layout-grid'} size={22} />
            <strong>{query ? 'No matching actions' : 'No actions here'}</strong>
            <p>{targetKind === 'dial' ? 'Select a key to see key-only actions.' : query ? 'Try an app name, “mute”, or “screenshot”.' : 'Browse all actions to find another option.'}</p>
            <button className="secondary" type="button" onClick={() => { if (query) { changeSearch(''); input.current?.focus(); } else showView('all'); }}>
              {query ? 'Clear search' : 'Browse all'}
            </button>
          </div>
        )}
      </div>
    </aside>
  );
}
