import { keyCount, modelById } from '../protocol/models.ts';
import { assertProfile } from '../shared/profile-validation.ts';
import type { ActionInstance, Profile } from '../shared/types.ts';
import { emptyPage } from './store.ts';

export function recoverProfile(source: Profile): { profile: Profile; changes: number } {
  const profile = structuredClone(source);
  try {
    assertProfile(profile);
    return { profile, changes: 0 };
  } catch {
    // Repair only the known editor defects, then pass the normal validator.
  }
  const model = modelById(profile?.modelId);
  if (!model || !profile.pages || Array.isArray(profile.pages) || !Array.isArray(profile.pageOrder)) {
    throw new Error('This profile has an unknown model or damaged page list.');
  }

  let changes = 0;
  for (const page of Object.values(profile.pages)) {
    for (const [kind, count] of [['keys', keyCount(model)], ['dials', model.encoders]] as const) {
      const slots = page[kind];
      if (!Array.isArray(slots)) throw new Error('This profile has a damaged slot list.');
      if (slots.length === count) continue;
      const overflow = slots.slice(count).filter(action => action !== null);
      if (!count && overflow.length) throw new Error('This model has no slots for the overflow actions.');
      page[kind] = Array.from({ length: count }, (_, index) => slots[index] ?? null);
      for (let index = 0; index < overflow.length; index += count) {
        const recovered = emptyPage(model.id, `Recovered ${kind}`);
        overflow.slice(index, index + count).forEach((action, offset) => { recovered[kind][offset] = action; });
        profile.pages[recovered.id] = recovered;
      }
      changes++;
    }
  }

  const owners = new Map<string, string>();
  const repairAction = (action: ActionInstance | null, owner: string | null, depth = 0): ActionInstance | null => {
    if (action === null) return null;
    if (!action || typeof action !== 'object' || !action.settings || depth > 32) throw new Error('This profile has a damaged action.');
    if (action.type === 'sd.folder') {
      const target = action.settings.folderId;
      if (typeof target !== 'string' || !Object.hasOwn(profile.pages, target)) {
        changes++;
        return {
          ...action,
          type: 'unsupported',
          settings: { elgatoUUID: 'Missing folder link', originalAction: action },
        };
      }
      if (owner !== null) {
        if (owners.has(target)) throw new Error('A folder has multiple owning keys. The repair cannot choose an owner.');
        owners.set(target, owner);
      }
    }
    if (Array.isArray(action.settings.steps)) {
      action.settings.steps = action.settings.steps.map(step => repairAction(step as ActionInstance, null, depth + 1));
    }
    return action;
  };

  for (const page of Object.values(profile.pages)) {
    page.keys = page.keys.map(action => repairAction(action, page.id));
    page.dials = page.dials.map(action => repairAction(action, page.id));
  }

  for (const page of Object.values(profile.pages)) {
    const parent = owners.get(page.id) ?? null;
    if ((page.parentId ?? null) !== parent) {
      page.parentId = parent;
      changes++;
    }
  }
  const roots = [...new Set([...profile.pageOrder, ...Object.keys(profile.pages)])]
    .filter(id => Object.hasOwn(profile.pages, id) && !profile.pages[id]!.parentId);
  if (roots.length !== profile.pageOrder.length || roots.some((id, index) => id !== profile.pageOrder[index])) changes++;
  profile.pageOrder = roots;
  assertProfile(profile);
  return { profile, changes };
}
