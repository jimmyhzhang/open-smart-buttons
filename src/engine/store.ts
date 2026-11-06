// Config persistence (~/.streamdeckplus/config.json + images/). Writes are debounced and atomic.

import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import type { Config, Page, Profile, Settings } from '../shared/types.ts';
import { keyCount, modelById } from '../protocol/models.ts';
import { ACTION_MAP, newInstance } from './actions.ts';
import { checkedRaster, MAX_IMAGE_BYTES } from './raster-image.ts';
import { assertProfile, checkSettingsPatch, MAX_PROFILES } from '../shared/profile-validation.ts';
import { isLocalAction } from '../shared/local-action-policy.ts';

export const DEFAULT_SETTINGS: Settings = {
  executeActions: false,
  pressFeedback: true,
  defaultBrightness: 70,
  sleepDelay: 0,
  autoSimulator: true,
  swipeChangesPages: true,
};

export function uid(): string {
  return randomUUID();
}

export function emptyPage(modelId: string, name: string, parentId: string | null = null): Page {
  const m = modelById(modelId)!;
  return { id: uid(), name, keys: new Array(keyCount(m)).fill(null), dials: new Array(m.encoders).fill(null), parentId };
}

export function starterProfile(modelId = 'plus', localOnly = false): Profile {
  const p1 = emptyPage(modelId, 'Main');
  const p2 = emptyPage(modelId, 'Page 2');
  const folder = emptyPage(modelId, 'Apps', p1.id);
  const mk = (type: string, settings: Record<string, unknown> = {}, title = '', icon?: string, bg?: string) => {
    const i = newInstance(type, uid());
    Object.assign(i.settings, settings);
    if (title) i.appearance.title = title;
    if (icon) i.appearance.icon = { kind: 'lucide', name: icon };
    if (bg) i.appearance.bg = bg;
    return i;
  };
  if (p1.keys.length >= 8) {
    p1.keys[0] = mk('system.multimedia', { action: 'playpause' }, 'Play', undefined, '#0f172a');
    p1.keys[1] = mk('system.multimedia', { action: 'previous' }, 'Prev', undefined, '#0f172a');
    p1.keys[2] = mk('system.multimedia', { action: 'next' }, 'Next', undefined, '#0f172a');
    p1.keys[3] = mk('sd.folder', { folderId: folder.id }, 'Apps', 'folder', '#431407');
    p1.keys[4] = mk('system.website', { url: 'https://github.com' }, 'GitHub', 'code-xml', '#111827');
    p1.keys[5] = mk('util.clock', {}, '', 'clock', '#082f49');
    p1.keys[6] = mk('util.counter', {}, 'Count', 'hash', '#3f0d12');
    p1.keys[7] = mk('sd.page.next', {}, 'Next page', 'chevron-right', '#1e293b');
    if (p1.dials.length >= 4) {
      p1.dials[0] = mk('system.volume', {}, 'Volume');
      p1.dials[1] = mk('sd.brightness', {}, 'Brightness');
      p1.dials[2] = mk('util.counter', {}, 'Counter');
      p1.dials[3] = mk('util.clock', {}, 'Clock');
    }
    folder.keys[0] = mk('sd.back', {}, 'Back', 'corner-up-left');
    folder.keys[1] = mk('system.open', { path: 'Safari' }, 'Safari', 'compass', '#0c4a6e');
    folder.keys[2] = mk('system.open', { path: 'Notes' }, 'Notes', 'notebook-pen', '#422006');
    folder.keys[3] = mk('system.open', { path: 'Terminal' }, 'Terminal', 'square-terminal', '#052e16');
    folder.keys[4] = mk('system.open', { path: 'Calculator' }, 'Calc', 'calculator', '#27272a');
    p2.keys[0] = mk('sd.page.prev', {}, 'Back', 'chevron-left', '#1e293b');
    p2.keys[1] = mk('system.hotkey', { hotkey: { key: '4', cmd: true, shift: true } }, 'Screenshot', 'camera', '#1e1b4b');
    p2.keys[2] = mk('system.text', { text: 'Hello from StreamDeckPlus!' }, 'Snippet', 'type', '#451a03');
    p2.keys[3] = mk('util.toggle', {}, 'Off', 'toggle-left', '#134e4a');
    if (p2.dials.length >= 2) {
      p2.dials[0] = mk('system.scroll', {}, 'Scroll');
      p2.dials[1] = mk('sd.page.indicator', {}, 'Pages');
    } else {
      p2.keys[7] = mk('sd.page.indicator', {}, 'Page', 'layers', '#1e293b');
    }
  }
  if (localOnly && p1.keys.length >= 8) {
    folder.name = 'Mac';
    p1.keys[3]!.appearance.title = 'Mac';
    p1.keys[0] = mk('system.volume', { mode: 'mute' }, 'Mute');
    p1.keys[1] = mk('system.volume', { mode: 'down', mutedIconWhenSilent: true }, 'Volume Down');
    p1.keys[2] = mk('system.volume', { mode: 'up' }, 'Volume Up');
    p1.keys[4] = mk('system.mac', { op: 'screenshot' }, 'Screenshot');
    folder.keys[1] = mk('system.mac', { op: 'darkmode' }, 'Dark Mode');
    folder.keys[2] = mk('system.mac', { op: 'lock' }, 'Lock');
    for (const page of [p1, p2, folder]) {
      page.keys = page.keys.map((key) => key && isLocalAction(key) ? key : null);
      page.dials = page.dials.map((dial) => dial && isLocalAction(dial) ? dial : null);
    }
  }
  return {
    id: uid(),
    name: 'Default',
    modelId,
    pageOrder: [p1.id, p2.id],
    pages: { [p1.id]: p1, [p2.id]: p2, ...(p1.keys.length >= 8 ? { [folder.id]: folder } : {}) },
    createdAt: Date.now(),
  };
}

export class Store {
  readonly dir: string;
  readonly imagesDir: string;
  config: Config;
  readonly localOnly: boolean;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private checkedImages = new Set<string>();

  constructor(dir = defaultDataDir(), localOnly = false) {
    this.dir = dir;
    this.localOnly = localOnly;
    this.imagesDir = join(dir, 'images');
    mkdirSync(this.imagesDir, { recursive: true, mode: 0o700 });
    this.config = this.load();
  }

  private load(): Config {
    const file = join(this.dir, 'config.json');
    if (existsSync(file)) {
      try {
        const c = JSON.parse(readFileSync(file, 'utf8')) as Config;
        if (c.version !== undefined && c.version !== 1 && c.version !== 2) throw new Error('Unsupported configuration version.');
        c.settings = { ...DEFAULT_SETTINGS, ...checkSettingsPatch(c.settings ?? {}) };
        c.deviceProfiles ??= {};
        if (!c.deviceProfiles || typeof c.deviceProfiles !== 'object' || Array.isArray(c.deviceProfiles) ||
          Object.values(c.deviceProfiles).some((id) => typeof id !== 'string')) throw new Error('Invalid device profile bindings.');
        if (!Array.isArray(c.profiles) || !c.profiles.length || c.profiles.length > MAX_PROFILES ||
          new Set(c.profiles.map((p) => p?.id)).size !== c.profiles.length) throw new Error('Invalid profile collection.');
        for (const p of c.profiles) assertProfile(p);
        if ((c.version ?? 1) < 2) {
          migrateAutoIcons(c);
          c.version = 2;
        }
        return c;
      } catch (e) {
        throw new Error(`Could not load ${file}. The file was preserved. See npm run recover or restore a known good backup.`, { cause: e });
      }
    }
    return { version: 2, profiles: [starterProfile('plus', this.localOnly)], deviceProfiles: {}, settings: { ...DEFAULT_SETTINGS } };
  }

  save(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      try { this.flush(); }
      catch (error) { console.error('Could not save StreamDeckPlus settings:', (error as Error).message); }
    }, 300);
    this.saveTimer.unref?.();
  }

  flush(config = this.config): void {
    const file = join(this.dir, 'config.json');
    writeFileSync(`${file}.tmp`, JSON.stringify(config, null, 2), { mode: 0o600, flush: true });
    renameSync(`${file}.tmp`, file);
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
  }

  profile(id: string): Profile | undefined {
    return this.config.profiles.find((p) => p.id === id);
  }

  profileForModel(modelId: string): Profile {
    let p = this.config.profiles.find((x) => x.modelId === modelId);
    if (!p) {
      if (this.config.profiles.length >= MAX_PROFILES) throw new Error('Remove a profile before adding another device model.');
      p = starterProfile(modelId, this.localOnly);
      this.config.profiles.push(p);
      this.save();
    }
    return p;
  }

  /** Store an uploaded image (content-addressed). Returns its id. */
  putImage(data: Uint8Array, _ext: string): string {
    const safeExt = checkedRaster(data);
    const id = `${createHash('sha256').update(data).digest('hex').slice(0, 20)}.${safeExt}`;
    const path = join(this.imagesDir, id);
    if (!existsSync(path)) writeFileSync(path, data, { mode: 0o600 });
    return id;
  }

  imagePath(id: string): string | null {
    if (!/^[a-f0-9]{20}\.(png|jpe?g)$/.test(id)) return null;
    const p = join(this.imagesDir, id);
    if (!existsSync(p)) return null;
    if (!this.checkedImages.has(id)) {
      try {
        if (statSync(p).size > MAX_IMAGE_BYTES || checkedRaster(readFileSync(p)) !== (id.endsWith('.png') ? 'png' : 'jpg')) return null;
      } catch { return null; }
      if (this.checkedImages.size >= 512) this.checkedImages.clear();
      this.checkedImages.add(id);
    }
    return p;
  }
}

export function defaultDataDir() {
  return process.env.STREAMDECKPLUS_DATA || join(homedir(), '.streamdeckplus');
}

/** Rev-1 configs stored the action's default icon on every instance, which made it look like a user choice.
 *  Treat those as "automatic" so live state icons work and explicit picks are honored. */
function migrateAutoIcons(c: Config): void {
  const visit = (inst: import('../shared/types.ts').ActionInstance | null) => {
    if (!inst) return;
    const ic = inst.appearance?.icon;
    if (ic?.kind === 'lucide' && ic.name === ACTION_MAP.get(inst.type)?.meta.icon ) delete inst.appearance.icon;
    const steps = inst.settings?.steps;
    if (Array.isArray(steps)) steps.forEach((x) => visit(x as any));
  };
  for (const p of c.profiles ?? []) for (const pg of Object.values(p.pages)) [...pg.keys, ...pg.dials].forEach(visit);
}
