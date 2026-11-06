import type { ActionInstance, Page } from './types.ts';

export type ActionClipboard = { instance: ActionInstance; folderPages?: Record<string, Page> };

/** Snapshot only the folder pages reachable from this action. No reference to its origin is needed. */
export function copyActionClipboard(instance: ActionInstance, pages: Record<string, Page>): ActionClipboard {
  if (!pages || typeof pages !== 'object' || Array.isArray(pages)) throw new Error('Folder clipboard pages must be an object. Copy the folder again.');
  const folderPages: Record<string, Page> = {};
  const pagePath = new Set<string>();
  const dataPath = new Set<object>();
  let budget = 30_000;
  const checkData = (value: unknown, depth = 0): void => {
    if (--budget < 0 || depth > 60) throw new Error('This clipboard action is too large or deeply nested to copy.');
    if (value === null || value === undefined || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return;
    if (typeof value !== 'object') throw new Error('Clipboard actions must contain ordinary data. Copy the action again.');
    if (dataPath.has(value)) throw new Error('Clipboard data contains a circular reference. Copy a valid action again.');
    dataPath.add(value);
    for (const child of Object.values(value)) checkData(child, depth + 1);
    dataPath.delete(value);
  };
  const visitAction = (action: ActionInstance): void => {
    if (!action || typeof action !== 'object' || Array.isArray(action) || typeof action.id !== 'string' || typeof action.type !== 'string' || !action.settings || typeof action.settings !== 'object' || Array.isArray(action.settings) || !action.appearance || typeof action.appearance !== 'object' || Array.isArray(action.appearance)) {
      throw new Error('Clipboard contains an invalid action. Copy the action again.');
    }
    if (action.type === 'sd.folder') visitPage(String(action.settings.folderId || ''));
    if (action.settings.steps !== undefined) {
      if (!Array.isArray(action.settings.steps)) throw new Error('Clipboard Multi Action steps must be a list.');
      for (const child of action.settings.steps) visitAction(child as ActionInstance);
    }
  };
  const visitPage = (id: string): void => {
    if (pagePath.has(id)) throw new Error('Clipboard folder tree contains a cycle. Copy a valid folder again.');
    if (Object.hasOwn(folderPages, id)) return;
    const source = Object.hasOwn(pages, id) ? pages[id] : undefined;
    if (!id || !source || source.id !== id || typeof source.name !== 'string' || !Array.isArray(source.keys) || !Array.isArray(source.dials)) throw new Error('A folder page is missing from the clipboard. Copy the folder and its contents again.');
    checkData(source);
    pagePath.add(id);
    for (const action of [...source.keys, ...source.dials]) if (action) visitAction(action);
    pagePath.delete(id);
    // defineProperty also safely handles a page whose id happens to be "__proto__".
    Object.defineProperty(folderPages, id, { value: structuredClone(source), enumerable: true, writable: true, configurable: true });
  };
  checkData(instance);
  visitAction(instance);
  for (const id of Object.keys(folderPages)) {
    const ancestors = new Set<string>();
    let current: string | null | undefined = id;
    while (current && Object.hasOwn(folderPages, current)) {
      if (ancestors.has(current)) throw new Error('Clipboard folder ancestry contains a cycle. Copy a valid folder again.');
      ancestors.add(current);
      current = folderPages[current]!.parentId;
    }
  }
  const copy = structuredClone(instance);
  return Object.keys(folderPages).length ? { instance: copy, folderPages } : { instance: copy };
}
