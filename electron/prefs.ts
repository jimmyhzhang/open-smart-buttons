// App preferences in userData/prefs.json (not the shared data directory, which the CLI also uses).

import { readFileSync, renameSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Prefs } from './protocol.ts';

export const DEFAULT_MODEL = 'claude-sonnet-5-5';

const DEFAULTS: Prefs = {
  onboarded: false,
  openAtLogin: true,
  showInMenuBar: true,
  checkForUpdates: false,
  closeNoticeShown: false,
  model: DEFAULT_MODEL,
  theme: 'system',
};

export class PrefStore {
  readonly file: string;
  value: Prefs;

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.file = join(dir, 'prefs.json');
    this.value = { ...DEFAULTS, ...read(this.file) };
  }

  set<K extends keyof Prefs>(key: K, value: Prefs[K]): void {
    this.value = { ...this.value, [key]: value };
    const temp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(this.value, null, 2), { mode: 0o600 });
    renameSync(temp, this.file);
  }
}

function read(file: string): Partial<Prefs> {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    const out: Partial<Prefs> = {};
    for (const key of ['onboarded', 'openAtLogin', 'showInMenuBar', 'checkForUpdates', 'closeNoticeShown'] as const) {
      if (typeof raw[key] === 'boolean') out[key] = raw[key] as boolean;
    }
    if (Number.isInteger(raw.port) && (raw.port as number) > 1024 && (raw.port as number) < 65536) out.port = raw.port as number;
    if (typeof raw.model === 'string' && /^[A-Za-z0-9._:@-]{1,100}$/.test(raw.model)) out.model = raw.model;
    if (raw.theme === 'light' || raw.theme === 'dark' || raw.theme === 'system') out.theme = raw.theme;
    const b = raw.windowBounds as Record<string, unknown> | undefined;
    if (b && ['x', 'y', 'width', 'height'].every((k) => Number.isFinite(b[k]))) out.windowBounds = b as Prefs['windowBounds'];
    return out;
  } catch {
    return {};
  }
}
