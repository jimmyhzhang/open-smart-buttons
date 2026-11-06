// Import Elgato .streamDeckProfile files (manifest version 2).

import type { ActionInstance, Appearance, Hotkey, Page, Profile, TitleAlign } from '../shared/types.ts';
import { keyCount, modelByCodename, modelById } from '../protocol/models.ts';
import { pageDirToUuid } from '../protocol/elgato-ids.ts';
import { readZip } from './zip.ts';
import { ACTIONS, newInstance } from './actions.ts';
import { uid } from './store.ts';

type Json = any;

// Maps stored multimedia action indices to supported operations.
const MEDIA_IDX: Record<number, string> = { 0: 'previous', 1: 'playpause', 2: 'next', 3: 'playpause', 4: 'mute', 5: 'volup', 6: 'voldown' };

// Qt::Key → our key names
function qtKey(code: number): string | null {
  if (code >= 0x30 && code <= 0x39) return String.fromCharCode(code);
  if (code >= 0x41 && code <= 0x5a) return String.fromCharCode(code).toLowerCase();
  const map: Record<number, string> = {
    0x20: 'Space', 0x01000000: 'Escape', 0x01000001: 'Tab', 0x01000003: 'Backspace', 0x01000004: 'Enter', 0x01000005: 'Enter',
    0x01000007: 'Delete', 0x01000010: 'Home', 0x01000011: 'End', 0x01000012: 'Left', 0x01000013: 'Up', 0x01000014: 'Right',
    0x01000015: 'Down', 0x01000016: 'PageUp', 0x01000017: 'PageDown',
    0x2c: ',', 0x2d: '-', 0x2e: '.', 0x2f: '/', 0x3b: ';', 0x3d: '=', 0x5b: '[', 0x5c: '\\', 0x5d: ']', 0x60: '`', 0x27: "'",
  };
  if (map[code]) return map[code]!;
  if (code >= 0x01000030 && code <= 0x01000043) return `F${code - 0x01000030 + 1}`;
  return null;
}

function hotkeyFrom(h: Json): Hotkey | null {
  if (!h || h.QTKeyCode === 33554431 || h.NativeCode === -1) return null;
  const key = qtKey(Number(h.QTKeyCode));
  if (!key) return null;
  return { key, cmd: !!h.KeyCmd, ctrl: !!h.KeyCtrl, opt: !!h.KeyOption, shift: !!h.KeyShift };
}

function cleanTitle(t: unknown): string {
  return typeof t === 'string' ? t.replace(/\n{2,}/g, '\n').trim() : '';
}

export interface ImportResult {
  profile: Profile;
  warnings: string[];
}

export function importElgatoProfile(
  data: Uint8Array,
  putImage: (bytes: Uint8Array, ext: string) => string,
  fallbackName = 'Imported',
): ImportResult {
  const files = readZip(data);
  const warnings: string[] = [];
  const rootManifestName = [...files.keys()].find((n) => /^[^/]+\.sdProfile\/manifest\.json$/.test(n));
  if (!rootManifestName) throw new Error('No <id>.sdProfile/manifest.json in archive');
  const root = rootManifestName.split('/')[0]!;
  const top: Json = JSON.parse(Buffer.from(files.get(rootManifestName)!).toString('utf8'));
  if (top.Version && !String(top.Version).startsWith('2')) warnings.push(`Profile version ${top.Version} may not import correctly`);
  const model = modelByCodename(top.Device?.Model) ?? modelById('plus')!;
  if (!modelByCodename(top.Device?.Model)) warnings.push(`Unknown device model ${top.Device?.Model}; imported as ${model.name}`);
  const columns = model.columns;

  const pages: Record<string, Page> = {};
  const folderParents = new Map<string, { parent: string; title: string }>();
  const pageDirs = new Set<string>();
  for (const n of files.keys()) {
    const m = n.match(new RegExp(`^${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/Profiles/([^/]+)/manifest\\.json$`));
    if (m) pageDirs.add(m[1]!);
  }

  const readImage = (dir: string, rel: unknown): string | null => {
    if (typeof rel !== 'string' || !rel) return null;
    const f = files.get(`${root}/Profiles/${dir}/${rel}`);
    if (!f) return null;
    try { return putImage(f, rel.split('.').pop() || 'png'); }
    catch { warnings.push('Skipped an invalid or unsupported profile image.'); return null; }
  };

  for (const dir of pageDirs) {
    const pageId = pageDirToUuid(dir) ?? uid();
    const pm: Json = JSON.parse(Buffer.from(files.get(`${root}/Profiles/${dir}/manifest.json`)!).toString('utf8'));
    const page: Page = {
      id: pageId,
      name: pm.Name || '',
      keys: new Array(keyCount(model)).fill(null),
      dials: new Array(model.encoders).fill(null),
      parentId: null,
    };
    for (const ctrl of pm.Controllers ?? []) {
      if (ctrl.Type !== 'Keypad' && ctrl.Type !== 'Encoder') continue;
      if (ctrl.Type === 'Encoder' && ctrl.Background) {
        const bg = readImage(dir, ctrl.Background);
        if (bg) page.touchBg = bg;
      }
      for (const [pos, a] of Object.entries<Json>(ctrl.Actions ?? {})) {
        const [col, row] = pos.split(',').map(Number) as [number, number];
        const isDial = ctrl.Type === 'Encoder';
        const inst = convertAction(a, isDial, dir, readImage, warnings);
        if (!inst) continue;
        if (inst.type === 'sd.folder' && inst.settings.folderId) folderParents.set(String(inst.settings.folderId), { parent: pageId, title: (inst.appearance.title ?? '').replace(/\s+/g, ' ').trim() });
        if (isDial) {
          if (col < page.dials.length) page.dials[col] = inst;
        } else {
          const idx = row * columns + col;
          if (idx < page.keys.length) page.keys[idx] = inst;
        }
      }
    }
    pages[pageId] = page;
  }

  const order: string[] = (top.Pages?.Pages ?? []).filter((id: string) => pages[id]);
  for (const [folderId, { parent, title }] of folderParents) {
    if (pages[folderId] && !order.includes(folderId)) {
      pages[folderId]!.parentId = parent;
      if (!pages[folderId]!.name) pages[folderId]!.name = title || 'Folder';
    }
  }
  // Pages neither listed nor referenced as folders: append so nothing is lost.
  for (const p of Object.values(pages)) {
    if (!order.includes(p.id) && !p.parentId) {
      order.push(p.id);
      warnings.push(`Page ${p.id.slice(0, 8)} was not in the page list; appended`);
    }
  }
  order.forEach((id, i) => {
    if (!pages[id]!.name) pages[id]!.name = `Page ${i + 1}`;
  });

  return {
    profile: {
      id: uid(),
      name: top.Name && top.Name !== 'Default Profile' ? top.Name : fallbackName,
      modelId: model.id,
      pageOrder: order,
      pages,
      createdAt: Date.now(),
      source: 'elgato',
    },
    warnings,
  };
}

function convertAction(
  a: Json,
  isDial: boolean,
  dir: string,
  readImage: (dir: string, rel: unknown) => string | null,
  warnings: string[],
): ActionInstance | null {
  const uuid: string = a.UUID ?? '';
  const s: Json = a.Settings ?? {};
  const state: Json = (a.States ?? [])[a.State ?? 0] ?? {};
  let inst: ActionInstance;
  const make = (type: string) => newInstance(type, uid());
  switch (uuid) {
    case 'com.elgato.streamdeck.system.website':
      inst = make('system.website');
      inst.settings.url = s.path ?? '';
      break;
    case 'com.elgato.streamdeck.system.open':
    case 'com.elgato.streamdeck.system.openapp':
      inst = make('system.open');
      inst.settings.path = s.path ?? s.appPath ?? '';
      break;
    case 'com.elgato.streamdeck.system.hotkey': {
      inst = make('system.hotkey');
      const hs: Json[] = s.Hotkeys ?? [];
      if (isDial) {
        inst.settings.left = hotkeyFrom(hs[0]);
        inst.settings.right = hotkeyFrom(hs[1]);
        inst.settings.press = hotkeyFrom(hs[2]);
      } else inst.settings.hotkey = hotkeyFrom(hs[0]);
      break;
    }
    case 'com.elgato.streamdeck.system.text':
      inst = make('system.text');
      inst.settings.text = s.pastedText ?? '';
      inst.settings.enter = !!s.isSendingEnter;
      break;
    case 'com.elgato.streamdeck.system.multimedia':
      if (isDial || s.actionIdx === 18) inst = make('system.volume');
      else {
        inst = make('system.multimedia');
        inst.settings.action = MEDIA_IDX[Number(s.actionIdx)] ?? 'playpause';
      }
      break;
    case 'com.elgato.streamdeck.system.keybrightness':
      inst = make('sd.brightness');
      break;
    case 'com.elgato.streamdeck.system.mouse-wheel':
      inst = make('system.scroll');
      break;
    case 'com.elgato.streamdeck.profile.openchild':
      inst = make('sd.folder');
      inst.settings.folderId = s.ProfileUUID ?? '';
      break;
    default: {
      const def = ACTIONS.find((d) => d.meta.elgato?.includes(uuid));
      if (def) inst = make(def.meta.type);
      else {
        inst = make('unsupported');
        inst.settings.elgatoUUID = uuid;
        inst.settings.elgatoName = a.Name ?? '';
        warnings.push(`Unsupported action ${a.Name ?? uuid} (${uuid})`);
      }
    }
  }
  const ap: Appearance = { ...inst.appearance };
  const title = cleanTitle(state.Title);
  if (title) ap.title = title;
  else ap.title = '';
  if (state.ShowTitle === false) ap.showTitle = false;
  if (typeof state.TitleColor === 'string' && state.TitleColor) ap.titleColor = state.TitleColor;
  if (state.FontSize) ap.titleSize = Math.round(Number(state.FontSize) * 1.35);
  if (['top', 'middle', 'bottom'].includes(state.TitleAlignment)) ap.titleAlign = state.TitleAlignment as TitleAlign;
  const img = readImage(dir, isDial ? (a.Encoder?.Icon ?? state.Image) : state.Image);
  if (img) ap.icon = { kind: 'image', id: img };
  if (isDial) {
    const bg = readImage(dir, a.Encoder?.background);
    if (bg) ap.bgImage = bg;
    if (a.Encoder?.IconVisible === false) ap.icon = { kind: 'none' };
    if (!title) ap.showTitle = false;
  }
  if (inst.type === 'unsupported' && !img) ap.title = ap.title || String(a.Name ?? 'Plugin');
  inst.appearance = ap;
  return inst;
}
