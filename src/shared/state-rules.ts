// State rules: a key or dial changes its icon, background or title while the computer is in a
// given state (muted, dark mode, an app in front…). Shared by the server, the UI and the button agent.

import type { IconRef } from './types.ts';

export type StateSourceId = 'volume' | 'muted' | 'micMuted' | 'darkMode' | 'frontApp' | 'appRunning' | 'battery' | 'pluggedIn';
export type StateValue = number | boolean | string;
export type StateOp = 'is' | 'isNot' | '<' | '<=' | '>' | '>=' | 'contains';
/** One reading as the UI sees it. A failed read keeps the last value and says why. */
export interface StateReading { value?: StateValue; error?: string; at: number }

export interface StateSourceMeta {
  id: StateSourceId;
  label: string;
  kind: 'number' | 'boolean' | 'text';
  unit?: string;
  /** Sources that read about one thing (an app) take its name. */
  arg?: { label: string; placeholder: string };
  /** Minimum time between reads. Rules are checked once a second at most. */
  intervalMs: number;
}

export const STATE_SOURCES: StateSourceMeta[] = [
  { id: 'volume', label: 'Output volume', kind: 'number', unit: '%', intervalMs: 1000 },
  { id: 'muted', label: 'Sound muted', kind: 'boolean', intervalMs: 1000 },
  { id: 'micMuted', label: 'Microphone muted', kind: 'boolean', intervalMs: 1000 },
  { id: 'darkMode', label: 'Dark mode', kind: 'boolean', intervalMs: 2000 },
  { id: 'frontApp', label: 'App in front', kind: 'text', intervalMs: 1000 },
  { id: 'appRunning', label: 'App is running', kind: 'boolean', arg: { label: 'App name', placeholder: 'Slack' }, intervalMs: 2000 },
  { id: 'battery', label: 'Battery level', kind: 'number', unit: '%', intervalMs: 30000 },
  { id: 'pluggedIn', label: 'Plugged in', kind: 'boolean', intervalMs: 10000 },
];
export const STATE_SOURCE_MAP = new Map(STATE_SOURCES.map((s) => [s.id, s]));

export const STATE_OPS: Record<StateSourceMeta['kind'], { value: StateOp; label: string }[]> = {
  number: [{ value: '<=', label: '≤' }, { value: '<', label: '<' }, { value: 'is', label: '=' }, { value: '>=', label: '≥' }, { value: '>', label: '>' }, { value: 'isNot', label: '≠' }],
  boolean: [{ value: 'is', label: 'is' }],
  text: [{ value: 'is', label: 'is' }, { value: 'isNot', label: 'is not' }, { value: 'contains', label: 'contains' }],
};

export interface StateRule {
  source: StateSourceId;
  /** The app name for appRunning. */
  arg?: string;
  op: StateOp;
  value: StateValue;
  /** What changes while the rule matches. Anything left out keeps the button's normal look. */
  icon?: IconRef;
  bg?: string;
  title?: string;
}

export const MAX_STATE_RULES = 8;

/** The cache key for one reading: rules about the same thing share it. */
export function stateKey(rule: Pick<StateRule, 'source' | 'arg'>): string {
  return STATE_SOURCE_MAP.get(rule.source)?.arg ? `${rule.source}:${(rule.arg ?? '').trim()}` : rule.source;
}

export function ruleMatches(rule: StateRule, value: StateValue | undefined): boolean {
  if (value === undefined) return false; // Unknown state never changes the look.
  const kind = STATE_SOURCE_MAP.get(rule.source)?.kind;
  if (kind === 'number') {
    const v = Number(value), target = Number(rule.value);
    if (!Number.isFinite(v) || !Number.isFinite(target)) return false;
    switch (rule.op) {
      case '<': return v < target;
      case '<=': return v <= target;
      case '>': return v > target;
      case '>=': return v >= target;
      case 'is': return v === target;
      case 'isNot': return v !== target;
      default: return false;
    }
  }
  if (kind === 'boolean') return rule.op === 'is' && value === rule.value;
  if (kind === 'text') {
    const v = String(value).trim().toLowerCase(), target = String(rule.value).trim().toLowerCase();
    if (rule.op === 'is') return v === target;
    if (rule.op === 'isNot') return v !== target;
    if (rule.op === 'contains') return !!target && v.includes(target);
  }
  return false;
}

/** The first matching rule wins. */
export function activeRule(rules: readonly StateRule[] | undefined, values: ReadonlyMap<string, StateValue>): StateRule | undefined {
  return rules?.find((r) => ruleMatches(r, values.get(stateKey(r))));
}

export function describeRule(rule: StateRule): string {
  const source = STATE_SOURCE_MAP.get(rule.source);
  if (!source) return rule.source;
  const subject = source.arg ? `${rule.arg || source.arg.placeholder} running` : source.label;
  if (source.kind === 'boolean') return rule.value ? subject : `not ${subject.charAt(0).toLowerCase()}${subject.slice(1)}`;
  const op = STATE_OPS[source.kind].find((o) => o.value === rule.op)?.label ?? rule.op;
  return `${source.label} ${op} ${String(rule.value)}${source.unit ?? ''}`;
}

const HEX = /^#[0-9a-f]{6}$/i;

function iconError(icon: unknown): string | null {
  if (!icon || typeof icon !== 'object') return 'icon must be an icon reference';
  const i = icon as Record<string, unknown>;
  if (i.kind === 'lucide' && typeof i.name === 'string' && /^[a-z0-9-]+$/.test(i.name)) return null;
  if (i.kind === 'emoji' && typeof i.char === 'string' && i.char.length > 0 && i.char.length <= 16) return null;
  if (i.kind === 'image' && typeof i.id === 'string' && /^[\w.-]+$/.test(i.id)) return null;
  if (i.kind === 'none') return null;
  return 'icon must be a Lucide icon, emoji, image or none';
}

/** Problems with a rule list, as user-facing sentences. Empty means it can be saved. */
export function validateStateRules(rules: unknown): string[] {
  if (!Array.isArray(rules)) return ['State rules must be a list'];
  if (rules.length > MAX_STATE_RULES) return [`Use at most ${MAX_STATE_RULES} state rules`];
  const errors: string[] = [];
  rules.forEach((raw, i) => {
    const at = `Rule ${i + 1}`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { errors.push(`${at} must be an object`); return; }
    const r = raw as Record<string, unknown>;
    const allowed = new Set(['source', 'arg', 'op', 'value', 'icon', 'bg', 'title']);
    const extra = Object.keys(r).find((k) => !allowed.has(k));
    if (extra) errors.push(`${at} has an unknown field “${extra}”`);
    const source = STATE_SOURCE_MAP.get(r.source as StateSourceId);
    if (!source) { errors.push(`${at} needs a known source (${STATE_SOURCES.map((s) => s.id).join(', ')})`); return; }
    if (source.arg) {
      if (typeof r.arg !== 'string' || !r.arg.trim() || r.arg.length > 100) errors.push(`${at}: enter the ${source.arg.label.toLowerCase()}`);
    } else if (r.arg !== undefined && r.arg !== '') errors.push(`${at}: ${source.label} takes no name`);
    if (!STATE_OPS[source.kind].some((o) => o.value === r.op)) errors.push(`${at}: “${String(r.op)}” doesn't apply to ${source.label}`);
    if (source.kind === 'number' && (typeof r.value !== 'number' || !Number.isFinite(r.value))) errors.push(`${at}: the value must be a number`);
    if (source.kind === 'boolean' && typeof r.value !== 'boolean') errors.push(`${at}: the value must be true or false`);
    if (source.kind === 'text' && (typeof r.value !== 'string' || !r.value.trim() || r.value.length > 100)) errors.push(`${at}: enter the text to compare`);
    if (r.icon === undefined && r.bg === undefined && r.title === undefined) errors.push(`${at} must change the icon, background or title`);
    if (r.icon !== undefined) { const e = iconError(r.icon); if (e) errors.push(`${at}: ${e}`); }
    if (r.bg !== undefined && (typeof r.bg !== 'string' || !HEX.test(r.bg))) errors.push(`${at}: the background must be a #RRGGBB color`);
    if (r.title !== undefined && (typeof r.title !== 'string' || r.title.length > 40)) errors.push(`${at}: the title must be at most 40 characters`);
  });
  return errors;
}
