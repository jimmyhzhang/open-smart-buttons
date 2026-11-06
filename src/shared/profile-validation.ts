import { keyCount, modelById } from '../protocol/models.ts';
import { validateStateRules } from './state-rules.ts';
import type { ActionInstance, Profile, Settings } from './types.ts';

export const MAX_PROFILES = 128;

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

const validId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 &&
  value.length <= 128 && !Object.hasOwn(Object.prototype, value);

export function checkSettingsPatch(value: unknown): Partial<Settings> {
  if (!record(value)) throw new Error('Settings must be an object.');
  for (const [key, setting] of Object.entries(value)) {
    if (['executeActions', 'pressFeedback', 'autoSimulator', 'swipeChangesPages'].includes(key) && typeof setting === 'boolean') continue;
    if (key === 'defaultBrightness' && typeof setting === 'number' && Number.isInteger(setting) && setting >= 0 && setting <= 100) continue;
    if (key === 'sleepDelay' && typeof setting === 'number' && Number.isInteger(setting) && setting >= 0 && setting <= 65535) continue;
    if (key === 'buttonAgent') {
      if (record(setting) && typeof setting.enabled === 'boolean' && ['codex', 'claude'].includes(String(setting.provider)) &&
        Object.keys(setting).length === 2) continue;
      throw new Error('Choose Codex or Claude Code for the background agent.');
    }
    throw new Error(`Invalid setting: ${key.slice(0, 80)}`);
  }
  return value as Partial<Settings>;
}

export function assertProfile(value: unknown): asserts value is Profile {
  if (!record(value) || !validId(value.id) || typeof value.name !== 'string' ||
    typeof value.modelId !== 'string' || !record(value.pages) || !Array.isArray(value.pageOrder) ||
    typeof value.createdAt !== 'number' || !Number.isFinite(value.createdAt)) throw new Error('Invalid StreamDeckPlus profile.');
  const model = modelById(value.modelId);
  const pages = value.pages;
  const entries = Object.entries(pages);
  if (!model || !entries.length || entries.length > 512 || !value.pageOrder.length ||
    value.pageOrder.length > entries.length || new Set(value.pageOrder).size !== value.pageOrder.length ||
    value.pageOrder.some((id) => !validId(id) || !Object.hasOwn(pages, id))) throw new Error('Invalid profile model or page order.');
  const roots = new Set(value.pageOrder);
  let remaining = 16_384;
  const actionIds = new Set<string>();
  const folders = new Map<string, string>();

  const checkAction = (raw: unknown, pageId: string, depth = 0): void => {
    if (--remaining < 0 || depth > 32 || !record(raw) || !validId(raw.id) || actionIds.has(raw.id) ||
      typeof raw.type !== 'string' || !raw.type || !record(raw.settings) || !record(raw.appearance)) {
      throw new Error('Profile contains an invalid or duplicate action.');
    }
    actionIds.add(raw.id);
    const action = raw as unknown as ActionInstance;
    if (action.appearance.title !== undefined && typeof action.appearance.title !== 'string') throw new Error('Invalid button title.');
    if (action.states !== undefined && (!Array.isArray(action.states) || action.states.length > 16 || !action.states.every(record))) {
      throw new Error('Invalid button states.');
    }
    if (action.stateRules !== undefined && validateStateRules(action.stateRules).length) throw new Error('Invalid button state rules.');
    if (action.type === 'sd.folder' && action.settings.folderId) {
      const id = action.settings.folderId;
      if (!validId(id) || !Object.hasOwn(pages, id)) {
        throw new Error(depth ? 'A Multi Action links to a missing folder. Remove or retarget that step before deleting the folder.' : 'Folder links to a missing page.');
      }
      if (!depth) {
        if (folders.has(id)) throw new Error('Folder has multiple owners.');
        folders.set(id, pageId);
      }
    }
    if (action.settings.steps !== undefined) {
      if (!Array.isArray(action.settings.steps) || action.settings.steps.length > 128) throw new Error('Invalid Multi Action steps.');
      for (const step of action.settings.steps) checkAction(step, pageId, depth + 1);
    }
  };

  for (const [id, page] of entries) {
    if (!validId(id) || !record(page) || page.id !== id || typeof page.name !== 'string' ||
      !Array.isArray(page.keys) || page.keys.length !== keyCount(model) || !Array.isArray(page.dials) || page.dials.length !== model.encoders) {
      throw new Error('Profile contains an invalid page or device layout.');
    }
    if (page.parentId != null && (!validId(page.parentId) || !Object.hasOwn(pages, page.parentId))) throw new Error('Invalid folder parent.');
    if (roots.has(id) !== (page.parentId == null)) throw new Error('Profile page order does not match its folder hierarchy.');
    for (const action of [...page.keys, ...page.dials]) if (action !== null) checkAction(action, id);
  }
  for (const [id, page] of entries) {
    const parent = (page as Profile['pages'][string]).parentId;
    if ((parent ?? undefined) !== folders.get(id)) throw new Error('Folder link and parent disagree.');
    const visited = new Set([id]);
    let current = parent;
    while (current) {
      if (visited.has(current) || visited.size > 32) throw new Error('Folder hierarchy is cyclic or too deep.');
      visited.add(current);
      current = (pages[current] as Profile['pages'][string]).parentId;
    }
  }
}
