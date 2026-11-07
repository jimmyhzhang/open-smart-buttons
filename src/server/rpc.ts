// RPC methods exposed to the UI over WebSocket. Every config mutation goes through here.

import type { Engine } from '../engine/engine.ts';
import type { ActionInstance, Appearance, Controller, Page, Profile } from '../shared/types.ts';
import { assertProfile, checkSettingsPatch, MAX_PROFILES } from '../shared/profile-validation.ts';
import { isLocalAction } from '../shared/local-action-policy.ts';
import { emptyPage, starterProfile, uid } from '../engine/store.ts';
import { ACTION_MAP, CATALOG, newInstance } from '../engine/actions.ts';
import { actionChoices, choiceAppearance, isOneStepChoice } from '../shared/action-presets.ts';
import { STARTER_LAYOUTS } from '../shared/starter-layouts.ts';
import { infoBarMode, touchPointMode } from '../shared/neo-options.ts';
import { importElgatoProfile } from '../engine/elgato-import.ts';
import { modelById } from '../protocol/models.ts';
import { validateActionSetup } from '../shared/action-setup.ts';
import { agentAvailability, agentWorkingDirectory } from '../engine/agent-launcher.ts';
import { buildScriptCommand, inspectScript, type ScriptCommandOptions } from '../engine/script-commands.ts';
import { copyActionClipboard, type ActionClipboard } from '../shared/action-clipboard.ts';
import { validateStateRules, type StateRule } from '../shared/state-rules.ts';
import { parseStateKey } from '../engine/state-hub.ts';
import { appIconPng, chooseOnMac, listInstalledApps, listShortcutNames, resolveApp, type PickKind } from '../engine/host.ts';

type Params = Record<string, any>;
export type RpcHandler = (p: Params) => unknown | Promise<unknown>;

export function createRpc(engine: Engine): Record<string, RpcHandler> {
  const store = engine.store;
  const cfg = () => store.config;
  const profile = (id: string): Profile => {
    const p = store.profile(id);
    if (!p) throw new Error(`No profile ${id}`);
    return p;
  };
  const page = (p: Profile, id: string): Page => {
    const pg = Object.hasOwn(p.pages, id) ? p.pages[id] : undefined;
    if (!pg) throw new Error(`No page ${id}`);
    return pg;
  };
  const session = (deviceId: string) => {
    const s = engine.sessions.get(deviceId);
    if (!s) throw new Error('Device not connected');
    return s;
  };
  const slots = (pg: Page, kind: 'key' | 'dial') => (kind === 'dial' ? pg.dials : pg.keys);
  const changed = () => engine.configChanged();
  // Stage the page graph and slot lists. Existing actions are shared until an edit replaces one.
  const editProfile = <T,>(original: Profile, edit: (draft: Profile) => T): T => {
    const draft: Profile = {
      ...original,
      pageOrder: [...original.pageOrder],
      pages: Object.fromEntries(Object.entries(original.pages).map(([id, pg]) => [
        id, { ...pg, keys: [...pg.keys], dials: [...pg.dials] },
      ])),
    };
    const result = edit(draft);
    assertProfile(draft);
    store.flush({ ...cfg(), profiles: cfg().profiles.map(p => p === original ? draft : p) });
    for (const [id, pg] of Object.entries(draft.pages)) {
      if (original.pages[id]) draft.pages[id] = Object.assign(original.pages[id]!, pg);
    }
    Object.assign(original, draft);
    engine.configChanged(false);
    return result;
  };
  const addPage = (p: Profile, pg: Page): void => {
    editProfile(p, (draft) => {
      draft.pages[pg.id] = pg;
      draft.pageOrder.push(pg.id);
    });
  };
  const addProfile = (p: Profile): string => {
    if (cfg().profiles.length >= MAX_PROFILES) throw new Error('Remove a profile before adding another.');
    assertProfile(p);
    store.flush({ ...cfg(), profiles: [...cfg().profiles, p] });
    cfg().profiles.push(p);
    engine.configChanged(false);
    return p.id;
  };

  // Runtime state is keyed globally by action id, including actions nested in multi-action steps.
  const renewActionIds = (inst: ActionInstance) => {
    inst.id = uid();
    const steps = inst.settings?.steps;
    if (Array.isArray(steps)) {
      for (const step of steps) {
        if (step && typeof step === 'object' && typeof step.type === 'string' && step.settings) renewActionIds(step as ActionInstance);
      }
    }
  };

  const cloneProfile = (src: Profile): Profile => {
    const p = structuredClone(src);
    p.id = uid();
    p.createdAt = Date.now();
    // Page ids and folder references are local to a profile and can stay unchanged.
    for (const pg of Object.values(p.pages)) {
      for (const inst of [...pg.keys, ...pg.dials]) if (inst) renewActionIds(inst);
    }
    return p;
  };

  /** Ensure folder actions own a folder page. */
  const ensureFolder = (p: Profile, pg: Page, inst: ActionInstance) => {
    if (inst.type !== 'sd.folder') return;
    const fid = String(inst.settings.folderId || '');
    if (fid && p.pages[fid]) return;
    const f = emptyPage(p.modelId, inst.appearance.title || 'Folder', pg.id);
    const back = newInstance('sd.back', uid());
    back.appearance.title = 'Back';
    f.keys[0] = back;
    p.pages[f.id] = f;
    inst.settings.folderId = f.id;
  };

  const deletePageTree = (p: Profile, id: string, seen = new Set<string>()) => {
    if (seen.has(id)) return;
    seen.add(id);
    const pg = p.pages[id];
    if (!pg) return;
    for (const inst of [...pg.keys, ...pg.dials]) {
      if (inst?.type === 'sd.folder' && inst.settings.folderId) deletePageTree(p, String(inst.settings.folderId), seen);
    }
    delete p.pages[id];
  };

  const cloneInstance = (inst: ActionInstance, p: Profile, targetPage: Page): ActionInstance => {
    const prepared = prepareClipboard(copyActionClipboard(inst, p.pages), p, targetPage);
    addClipboardPages(p, prepared.pages);
    return prepared.instance;
  };

  const addClipboardPages = (p: Profile, pages: Record<string, Page>): void => {
    Object.assign(p.pages, pages);
    for (const pg of Object.values(pages)) if (!pg.parentId) p.pageOrder.push(pg.id);
  };

  /** Validate a detached candidate; collect script IO without mutating the saved instance. */
  const preflightConfiguredAction = (action: ActionInstance, controller: Controller, p: Profile): ScriptCommandOptions[] => {
    const def = ACTION_MAP.get(action.type);
    if (!def) throw new Error(`Unknown action ${action.type}`);
    const errors = validateActionSetup(def.meta, action.settings, controller, (type) => ACTION_MAP.get(type)?.meta);
    if (errors.length) throw new Error(errors[0]);
    const scripts: ScriptCommandOptions[] = [];
    const visit = (candidate: ActionInstance, nested = false) => {
      if (candidate.type.startsWith('agent.')) agentWorkingDirectory(candidate.settings.cwd);
      if (nested && candidate.type === 'sd.folder' && !p.pages[String(candidate.settings.folderId)]) throw new Error('The folder selected for this Multi Action step no longer exists');
      if (candidate.type === 'system.script') {
        const args = [candidate.settings.arg1 ?? '', candidate.settings.arg2 ?? '', candidate.settings.arg3 ?? ''] as string[];
        while (args.length && args.at(-1) === '') args.pop();
        scripts.push({ path: candidate.settings.path as string, args });
      }
      if (candidate.type === 'sd.multi') for (const child of candidate.settings.steps as ActionInstance[]) {
        child.settings = { ...structuredClone(ACTION_MAP.get(child.type)!.meta.defaults), ...child.settings };
        visit(child, true);
      }
    };
    visit(action);
    return scripts;
  };

  /** Prepare a portable clipboard tree entirely off-config so malformed input cannot partially paste. */
  const prepareClipboard = (clipboard: ActionClipboard, targetProfile: Profile, targetPage: Page, additionalPageIds: ReadonlyMap<string, string> = new Map()) => {
    const snapshot = copyActionClipboard(clipboard.instance, clipboard.folderPages ?? {});
    const sourcePages = snapshot.folderPages ?? {};
    const pageIds = new Map(Object.keys(sourcePages).map((id) => [id, uid()]));
    const referenceIds = new Map([...additionalPageIds, ...pageIds]);
    const parents = new Map<string, string | null>();
    const collectOwner = (action: ActionInstance, owner: string | null) => {
      if (action.type === 'sd.folder') {
        const id = String(action.settings.folderId);
        if (parents.has(id)) throw new Error('This clipboard folder has multiple owning keys.');
        parents.set(id, owner);
      }
    };
    const roots = additionalPageIds.size ? snapshot.instance.settings.steps as ActionInstance[] : [snapshot.instance];
    for (const action of roots) collectOwner(action, null);
    for (const [id, pg] of Object.entries(sourcePages)) for (const action of [...pg.keys, ...pg.dials]) if (action) collectOwner(action, id);
    const cloneAction = (source: ActionInstance): ActionInstance => {
      const action = structuredClone(source);
      const remap = (inst: ActionInstance) => {
        inst.id = uid();
        if (inst.type === 'sd.folder') inst.settings.folderId = pageIds.get(String(inst.settings.folderId))!;
        if (inst.type === 'sd.page.goto' && referenceIds.has(String(inst.settings.pageId))) inst.settings.pageId = referenceIds.get(String(inst.settings.pageId))!;
        if (Array.isArray(inst.settings.steps)) for (const child of inst.settings.steps) remap(child as ActionInstance);
      };
      remap(action);
      return action;
    };
    const pages: Record<string, Page> = {};
    for (const [id, source] of Object.entries(sourcePages)) {
      const owner = parents.get(id);
      // A Multi Action can reference a page but does not own its lifetime.
      const parentId = owner === null ? targetPage.id : owner ? pageIds.get(owner)! : null;
      const pg = { ...structuredClone(source), ...emptyPage(targetProfile.modelId, source.name, parentId), id: pageIds.get(id)! };
      if (source.keys.slice(pg.keys.length).some(Boolean) || source.dials.slice(pg.dials.length).some(Boolean)) throw new Error('This device has fewer keys or dials than the copied folder. Paste into a compatible profile to keep every action.');
      source.keys.slice(0, pg.keys.length).forEach((action, i) => { pg.keys[i] = action ? cloneAction(action) : null; });
      source.dials.slice(0, pg.dials.length).forEach((action, i) => { pg.dials[i] = action ? cloneAction(action) : null; });
      pages[pg.id] = pg;
    }
    return { instance: cloneAction(snapshot.instance), pages };
  };

  /** Puts a starter layout's presets into a page's empty slots, in order. Returns how many were placed. */
  const fillStarter = async (pg: Page, layoutId: string): Promise<{ kind: Controller; index: number }[]> => {
    const layout = STARTER_LAYOUTS.find((l) => l.id === layoutId);
    if (!layout) throw new Error('Unknown starter layout');
    const choices = actionChoices(CATALOG);
    const resolve = (t: string) => ACTION_MAP.get(t)?.meta;
    const icons = new Map<string, string | null>();
    const build = async (id: string, kind: Controller) => {
      const choice = choices.find((c) => c.id === id);
      const meta = choice && resolve(choice.type);
      if (!choice || !meta || !isOneStepChoice(choice, meta, kind, resolve)) return null;
      const inst = newInstance(choice.type, uid());
      inst.settings = { ...inst.settings, ...structuredClone(choice.settings) };
      if (engine.localOnly && !isLocalAction(inst)) return null;
      if (kind === 'key') inst.appearance = { ...inst.appearance, ...choiceAppearance(choice, meta) };
      if (choice.type === 'system.open' && process.platform === 'darwin') {
        const app = String(choice.settings.path ?? '');
        if (!icons.has(app)) {
          const path = resolveApp(app);
          const png = path ? await appIconPng(path).catch(() => null) : null;
          icons.set(app, png ? store.putImage(png, 'png') : null);
        }
        const icon = icons.get(app);
        if (icon) inst.appearance.icon = { kind: 'image', id: icon };
      }
      return inst;
    };
    const placed: { kind: Controller; index: number }[] = [];
    for (const [kind, ids] of [['key', layout.keys], ['dial', layout.dials ?? []]] as const) {
      const arr = slots(pg, kind);
      const queue = [...ids];
      for (let i = 0; i < arr.length && queue.length; i++) {
        if (arr[i]) continue;
        let inst: ActionInstance | null = null;
        while (!inst && queue.length) inst = await build(queue.shift()!, kind);
        if (inst) { arr[i] = inst; placed.push({ kind, index: i }); }
      }
    }
    return placed;
  };

  return {
    'integrations.status': () => ({ agents: agentAvailability().map(({ tool, name, installed }) => ({ tool, name, installed })) }),
    'scripts.inspect': ({ path }) => inspectScript(String(path || '')),
    'shortcuts.list': () => process.platform === 'darwin' ? listShortcutNames() : [],
    // ---- host conveniences for setup (never run an action) -----------------------------------
    'host.info': () => ({ canPick: process.platform === 'darwin' }),
    'host.choose': async ({ kind, prompt }) => {
      if (process.platform !== 'darwin') throw new Error('Browsing needs macOS. Type the path instead.');
      if (!['folder', 'file', 'app'].includes(String(kind))) throw new Error('Choose a folder, file or app');
      return chooseOnMac(kind as PickKind, String(prompt || 'Choose'));
    },
    'host.apps': () => (process.platform === 'darwin' ? listInstalledApps() : []),
    'host.appIcon': async ({ app }) => {
      if (process.platform !== 'darwin') return null;
      const path = resolveApp(String(app || ''));
      const png = path ? await appIconPng(path) : null;
      return png ? store.putImage(png, 'png') : null;
    },
    // ---- devices ----------------------------------------------------------------------------
    'devices.scan': async () => engine.manager.scan(),
    // After wake or a supervisor restart: find devices again and repaint every connected surface.
    'devices.refresh': async () => {
      await engine.manager.scan();
      for (const s of engine.sessions.values()) s.renderAll(true);
    },
    'devices.connect': async ({ path }) => {
      const d = await engine.manager.connect(path);
      return d.id;
    },
    'devices.disconnect': ({ deviceId }) => engine.manager.disconnect(deviceId),
    'devices.reconnect': async ({ deviceId }) => (await engine.manager.reconnect(deviceId)).id,
    'devices.setBrightness': async ({ deviceId, value }) => {
      const s = session(deviceId);
      await s.dev.setBrightness(value);
      s.renderAll();
      engine.emit('state');
    },
    'devices.setSleepDelay': async ({ deviceId, seconds }) => {
      checkSettingsPatch({ sleepDelay: seconds });
      await session(deviceId).dev.setSleepDelay(seconds);
      cfg().settings.sleepDelay = seconds;
      changed();
    },
    'devices.reset': async ({ deviceId }) => {
      const s = session(deviceId);
      await s.dev.reset();
      setTimeout(() => s.renderAll(true), 1500);
    },
    'devices.identify': async ({ deviceId }) => {
      const s = session(deviceId);
      const b = s.dev.brightness;
      for (let i = 0; i < 3; i++) {
        await s.dev.setBrightness(100);
        await new Promise((r) => setTimeout(r, 160));
        await s.dev.setBrightness(10);
        await new Promise((r) => setTimeout(r, 160));
      }
      await s.dev.setBrightness(b);
    },
    'devices.virtualInput': ({ deviceId, report }) => {
      const s = session(deviceId);
      const bytes = Uint8Array.from(report as number[]);
      const sim = engine.manager.simFor(s.dev);
      if (sim) sim.inject(bytes);
      else s.dev.injectInput(bytes);
    },

    // ---- simulator --------------------------------------------------------------------------
    'sim.add': async ({ modelId }) => (await engine.manager.addSimulator(modelId ?? 'plus')).id,
    'sim.remove': ({ deviceId }) => engine.manager.removeSimulator(deviceId),
    'sim.unplug': ({ deviceId }) => {
      const sim = engine.manager.simFor(session(deviceId).dev);
      if (!sim) throw new Error('Not a simulator');
      sim.unplug();
    },

    // ---- sessions ---------------------------------------------------------------------------
    'session.setProfile': ({ deviceId, profileId }) => engine.setSessionProfile(deviceId, profileId),
    'session.setPage': ({ deviceId, pageId }) => {
      session(deviceId).setPage(pageId);
    },
    'session.back': ({ deviceId }) => {
      const s = session(deviceId);
      const prev = s.stack[s.stack.length - 1];
      if (prev) s.setPage(prev);
    },

    // ---- profiles ---------------------------------------------------------------------------
    'profiles.create': ({ name, modelId, blank }) => {
      const m = modelById(modelId ?? 'plus');
      if (!m) throw new Error('Unknown model');
      let p: Profile;
      if (blank !== false) {
        const pg = emptyPage(m.id, 'Page 1');
        p = { id: uid(), name: name || 'New Profile', modelId: m.id, pageOrder: [pg.id], pages: { [pg.id]: pg }, createdAt: Date.now() };
      } else {
        p = starterProfile(m.id, engine.localOnly);
        p.name = name || p.name;
      }
      return addProfile(p);
    },
    'profiles.setNeo': ({ profileId, touchPoints, infoBar }) => {
      const p = profile(profileId);
      const next = { ...p.neo };
      if (touchPoints !== undefined) next.touchPoints = touchPointMode(touchPoints);
      if (infoBar !== undefined) next.infoBar = infoBarMode(infoBar);
      p.neo = next;
      changed();
      for (const s of engine.sessions.values()) if (s.profileId === profileId) s.renderAll();
    },
    'profiles.rename': ({ profileId, name }) => {
      editProfile(profile(profileId), (draft) => { draft.name = String(name).slice(0, 60) || 'Untitled'; });
    },
    'profiles.duplicate': ({ profileId }) => {
      const src = profile(profileId);
      const p = cloneProfile(src);
      p.name = `${src.name} copy`;
      return addProfile(p);
    },
    'profiles.delete': ({ profileId }) => {
      const p = profile(profileId);
      if (cfg().profiles.filter((x) => x.modelId === p.modelId).length <= 1) throw new Error('A device needs at least one profile');
      const profiles = cfg().profiles.filter((x) => x.id !== profileId);
      const deviceProfiles = Object.fromEntries(Object.entries(cfg().deviceProfiles).filter(([, id]) => id !== profileId));
      store.flush({ ...cfg(), profiles, deviceProfiles });
      Object.assign(cfg(), { profiles, deviceProfiles });
      engine.configChanged(false);
    },
    'profiles.export': ({ profileId }) => profile(profileId),
    'profiles.importJson': ({ data }) => {
      assertProfile(data);
      return addProfile(cloneProfile(data));
    },
    'profiles.importElgato': ({ base64, name }) => {
      const { profile: p, warnings } = importElgatoProfile(Buffer.from(String(base64), 'base64'), (b, ext) => store.putImage(b, ext), String(name || 'Imported').replace(/\.streamDeckProfile$/i, ''));
      return { profileId: addProfile(p), warnings };
    },

    // ---- pages ------------------------------------------------------------------------------
    'pages.add': ({ profileId, deviceId }) => {
      const p = profile(profileId);
      const pg = emptyPage(p.modelId, `Page ${p.pageOrder.length + 1}`);
      addPage(p, pg);
      if (deviceId && engine.sessions.get(deviceId)?.profileId === profileId) engine.sessions.get(deviceId)!.setPage(pg.id);
      return pg.id;
    },
    'pages.addStarter': async ({ profileId, deviceId, layoutId }) => {
      const p = profile(profileId);
      const layout = STARTER_LAYOUTS.find((l) => l.id === layoutId);
      if (!layout) throw new Error('Unknown starter layout');
      const pg = emptyPage(p.modelId, layout.name);
      await fillStarter(pg, layout.id);
      addPage(profile(profileId), pg);
      if (deviceId && engine.sessions.get(deviceId)?.profileId === profileId) engine.sessions.get(deviceId)!.setPage(pg.id);
      return pg.id;
    },
    'pages.fillStarter': async ({ profileId, pageId, layoutId }) => {
      const pg = page(profile(profileId), pageId);
      // Fill a copy, then commit, so a failure leaves the page untouched.
      const draft: Page = { ...pg, keys: [...pg.keys], dials: [...pg.dials] };
      const placed = await fillStarter(draft, String(layoutId));
      if (!placed.length) return { placed: 0, added: [] };
      // Commit only the new buttons, and only into slots that are still empty.
      return editProfile(profile(profileId), (candidate) => {
        const current = page(candidate, pageId);
        const added: { kind: Controller; index: number; id: string }[] = [];
        for (const { kind, index } of placed) {
          const inst = slots(draft, kind)[index]!;
          const target = slots(current, kind);
          if (index < target.length && !target[index]) { target[index] = inst; added.push({ kind, index, id: inst.id }); }
        }
        return { placed: added.length, added };
      });
    },
    'pages.rename': ({ profileId, pageId, name }) => {
      editProfile(profile(profileId), (draft) => {
        page(draft, pageId).name = String(name).slice(0, 40) || 'Page';
      });
    },
    'pages.delete': ({ profileId, pageId }) => {
      const p = profile(profileId);
      if (page(p, pageId).parentId) throw new Error('Remove the owning folder key to delete this folder.');
      if (p.pageOrder.length <= 1) throw new Error('A profile needs at least one page');
      editProfile(p, (draft) => {
        deletePageTree(draft, pageId);
        draft.pageOrder = draft.pageOrder.filter((id) => id !== pageId);
      });
    },
    'pages.duplicate': ({ profileId, pageId }) => {
      const p = profile(profileId);
      const src = page(p, pageId);
      if (src.parentId) throw new Error('Copy the owning folder key to duplicate this folder.');
      const pg: Page = structuredClone(src);
      pg.id = uid();
      pg.name = `${src.name} copy`;
      // One snapshot/map covers every slot, so jumps between copied folders and back to
      // the copied root cannot retain targets in the original page tree.
      const container = newInstance('sd.multi', uid());
      container.settings.steps = [...src.keys, ...src.dials].filter((action) => action !== null);
      const prepared = prepareClipboard(copyActionClipboard(container, p.pages), p, pg, new Map([[src.id, pg.id]]));
      const actions = prepared.instance.settings.steps as ActionInstance[];
      let next = 0;
      pg.keys = src.keys.map((action) => action ? actions[next++]! : null);
      pg.dials = src.dials.map((action) => action ? actions[next++]! : null);
      editProfile(p, (draft) => {
        addClipboardPages(draft, prepared.pages);
        draft.pages[pg.id] = pg;
        draft.pageOrder.splice(draft.pageOrder.indexOf(pageId) + 1, 0, pg.id);
      });
      return pg.id;
    },
    'pages.reorder': ({ profileId, order }) => {
      const p = profile(profileId);
      if (!Array.isArray(order) || order.length !== p.pageOrder.length || new Set(order).size !== order.length ||
        order.some((id) => typeof id !== 'string' || !p.pageOrder.includes(id))) throw new Error('Order must contain every page exactly once');
      editProfile(p, (draft) => { draft.pageOrder = [...order]; });
    },
    'pages.setTouchBg': ({ profileId, pageId, imageId }) => {
      page(profile(profileId), pageId).touchBg = imageId || undefined;
      changed();
    },

    // ---- slots ------------------------------------------------------------------------------
    'slots.assign': ({ profileId, pageId, kind, index, type, settings, appearance, configured, replaceFolder, expectEmpty, expectedActionId }) => {
      if (kind !== 'key' && kind !== 'dial') throw new Error('Choose a key or dial');
      const p = profile(profileId);
      const pg = page(p, pageId);
      const def = ACTION_MAP.get(type);
      if (!def) throw new Error(`Unknown action ${type}`);
      if (!def.meta.controllers.includes(kind)) throw new Error(`${def.meta.name} can't go on a ${kind}`);
      const inst = newInstance(type, uid());
      let scripts: ScriptCommandOptions[] = [];
      if (configured) {
        if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('Action settings must be an object');
        inst.settings = { ...inst.settings, ...structuredClone(settings) };
        if (type === 'sd.folder') delete inst.settings.folderId;
        scripts = preflightConfiguredAction(inst, kind, p);
        if (appearance && typeof appearance === 'object' && !Array.isArray(appearance)) inst.appearance = { ...inst.appearance, ...structuredClone(appearance) };
      }
      const arr = slots(pg, kind);
      if (!Number.isInteger(index) || index < 0 || index >= arr.length) throw new Error('Slot out of range');
      const old = arr[index];
      if (expectEmpty && old) throw new Error('That button was just filled. Pick another one.');
      if (expectedActionId !== undefined && (old?.id ?? null) !== expectedActionId) throw new Error('This key changed. Review its current action before replacing it.');
      if (configured && old?.type === 'sd.folder' && old.settings.folderId && !replaceFolder) throw new Error('Confirm replacing the folder and its contents first');
      const expectedId = old?.id ?? null;
      const commit = () => {
        const currentProfile = profile(profileId);
        const currentPage = page(currentProfile, pageId);
        const currentSlots = slots(currentPage, kind);
        if (index >= currentSlots.length || (currentSlots[index]?.id ?? null) !== expectedId) throw new Error('This button changed while setup was being checked. Open its setup again before replacing it.');
        const current = currentSlots[index];
        if (current?.type === 'sd.folder' && current.settings.folderId && replaceFolder !== true) throw new Error('Confirm replacing the folder and its contents first');
        return editProfile(currentProfile, (draft) => {
          const target = page(draft, pageId);
          if (current?.type === 'sd.folder' && current.settings.folderId) deletePageTree(draft, String(current.settings.folderId));
          slots(target, kind)[index] = inst;
          ensureFolder(draft, target, inst);
          return inst.id;
        });
      };
      return scripts.length ? Promise.all(scripts.map((script) => buildScriptCommand(script))).then(commit) : commit();
    },
    'slots.update': ({ profileId, pageId, kind, index, settings, appearance, states, stateRules, expectedActionId }) => {
      if (kind !== 'key' && kind !== 'dial') throw new Error('Choose a key or dial');
      const p = profile(profileId);
      const pg = page(p, pageId);
      if (!Number.isInteger(index) || index < 0 || index >= slots(pg, kind).length) throw new Error('Slot out of range');
      const inst = slots(pg, kind)[index];
      if (!inst) throw new Error('Empty slot');
      if (expectedActionId !== undefined && expectedActionId !== inst.id) throw new Error('This button changed. Open its setup again before editing it.');
      const originalSettings = inst.settings;
      let candidate: ActionInstance | undefined;
      let scripts: ScriptCommandOptions[] = [];
      if (settings !== undefined) {
        if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('Action settings must be an object');
        candidate = { ...inst, settings: { ...structuredClone(inst.settings), ...structuredClone(settings) } };
        if (inst.type === 'sd.folder' && candidate.settings.folderId !== inst.settings.folderId) throw new Error('An existing folder cannot be linked to a different page.');
        scripts = preflightConfiguredAction(candidate, kind, p);
      }
      const appearancePatch = appearance ? structuredClone(appearance) as Appearance : undefined;
      const statePatch = states ? structuredClone(states) as Appearance[] : undefined;
      if (stateRules !== undefined) {
        const errors = validateStateRules(stateRules);
        if (errors.length) throw new Error(errors.join('; '));
      }
      const rulesPatch = stateRules !== undefined ? structuredClone(stateRules) as StateRule[] : undefined;
      const commit = () => {
        const currentProfile = profile(profileId);
        const current = slots(page(currentProfile, pageId), kind)[index];
        if (!current || current.id !== inst.id) throw new Error('This button changed while setup was being checked. Open its setup again before editing it.');
        if (candidate && current.settings !== originalSettings) throw new Error('These action settings changed while setup was being checked. Open its setup again before editing it.');
        editProfile(currentProfile, (draft) => {
          const updated = { ...current };
          if (candidate) updated.settings = candidate.settings;
          if (appearancePatch) {
            const merged: Record<string, unknown> = { ...current.appearance, ...appearancePatch };
            for (const [k, v] of Object.entries(appearancePatch)) if (v === null && k !== 'bgImage') delete merged[k];
            updated.appearance = merged as Appearance;
          }
          if (statePatch) updated.states = statePatch;
          if (rulesPatch?.length) updated.stateRules = rulesPatch;
          else if (rulesPatch) delete updated.stateRules;
          slots(page(draft, pageId), kind)[index] = updated;
          const folder = updated.type === 'sd.folder' && draft.pages[String(updated.settings.folderId)];
          if (folder && updated.appearance.title) folder.name = updated.appearance.title;
        });
      };
      return scripts.length ? Promise.all(scripts.map((script) => buildScriptCommand(script))).then(commit) : commit();
    },
    'slots.clear': ({ profileId, pageId, kind, index, deleteFolder, expectedActionId }) => {
      if (kind !== 'key' && kind !== 'dial') throw new Error('Choose a key or dial');
      const p = profile(profileId);
      const arr = slots(page(p, pageId), kind);
      if (!Number.isInteger(index) || index < 0 || index >= arr.length) throw new Error('Slot out of range');
      const old = arr[index];
      if (expectedActionId !== undefined && old?.id !== expectedActionId) throw new Error('This button changed. Select it again before removing it.');
      if (old?.type === 'sd.folder' && old.settings.folderId && deleteFolder !== true) throw new Error('Confirm deleting this folder and its contents first');
      editProfile(p, (draft) => {
        if (old?.type === 'sd.folder' && old.settings.folderId) deletePageTree(draft, String(old.settings.folderId));
        slots(page(draft, pageId), kind)[index] = null;
      });
    },
    'slots.move': ({ profileId, from, to, copy, expectEmpty }) => {
      // from/to: { pageId, kind, index }
      const p = profile(profileId);
      if (!from || !to || !['key', 'dial'].includes(from.kind) || !['key', 'dial'].includes(to.kind)) throw new Error('Choose a key or dial');
      const fa = slots(page(p, from.pageId), from.kind);
      const ta = slots(page(p, to.pageId), to.kind);
      if (![from.index, to.index].every(Number.isInteger) || from.index < 0 || to.index < 0 ||
        from.index >= fa.length || to.index >= ta.length) throw new Error('Slot out of range');
      if (fa === ta && from.index === to.index) return;
      const src = fa[from.index];
      if (!src) return;
      const def = ACTION_MAP.get(src.type);
      if (def && !def.meta.controllers.includes(to.kind)) throw new Error(`${def.meta.name} can't go on a ${to.kind}`);
      if (expectEmpty && ta[to.index]) throw new Error('That button was just filled. Try again.');
      if (copy) {
        if (ta[to.index]?.type === 'sd.folder') throw new Error('Choose another destination or use Paste to confirm replacing this folder.');
        editProfile(p, (draft) => {
          const target = page(draft, to.pageId);
          slots(target, to.kind)[to.index] = cloneInstance(src, draft, target);
        });
      } else {
        const dst = ta[to.index] ?? null;
        if (dst && ACTION_MAP.get(dst.type) && !ACTION_MAP.get(dst.type)!.meta.controllers.includes(from.kind)) {
          throw new Error(`Can't swap: ${ACTION_MAP.get(dst.type)!.meta.name} can't go on a ${from.kind}`);
        }
        editProfile(p, (draft) => {
          slots(page(draft, from.pageId), from.kind)[from.index] = dst;
          slots(page(draft, to.pageId), to.kind)[to.index] = src;
          for (const [action, owner] of [[src, to.pageId], [dst, from.pageId]] as const) {
            const folder = action?.type === 'sd.folder' && draft.pages[String(action.settings.folderId)];
            if (folder) folder.parentId = owner;
          }
        });
      }
    },
    'slots.paste': ({ profileId, pageId, kind, index, instance, folderPages, replaceFolder }) => {
      if (kind !== 'key' && kind !== 'dial') throw new Error('Choose a key or dial');
      const p = profile(profileId);
      const pg = page(p, pageId);
      const arr = slots(pg, kind);
      if (!Number.isInteger(index) || index < 0 || index >= arr.length) throw new Error('Slot out of range');
      const src = instance as ActionInstance;
      const def = ACTION_MAP.get(src?.type);
      if (!def) throw new Error('Clipboard has no action');
      if (!def.meta.controllers.includes(kind)) throw new Error(`${def.meta.name} can't go on a ${kind}`);
      const old = arr[index];
      if (old?.type === 'sd.folder' && old.settings.folderId && replaceFolder !== true) throw new Error('Confirm replacing the destination folder and its contents before pasting.');
      if (folderPages !== undefined && (!folderPages || typeof folderPages !== 'object' || Array.isArray(folderPages))) throw new Error('Clipboard folder pages must be an object. Copy the folder again.');
      const prepared = prepareClipboard({ instance: src, folderPages }, p, pg);
      editProfile(p, (draft) => {
        if (old?.type === 'sd.folder' && old.settings.folderId) deletePageTree(draft, String(old.settings.folderId));
        addClipboardPages(draft, prepared.pages);
        slots(page(draft, pageId), kind)[index] = prepared.instance;
      });
    },
    'slots.test': ({ deviceId, kind, index }) => engine.testAction(deviceId, kind, index),
    /** Current values for the state rules being edited, e.g. ["volume", "appRunning:Zoom"]. */
    'states.read': async ({ keys, deviceId }) => {
      if (!Array.isArray(keys) || keys.length > 16) throw new Error('Ask for up to 16 states');
      for (const key of keys) parseStateKey(String(key));
      const hub = deviceId === undefined ? engine.states : session(deviceId).stateHub;
      await engine.refreshStates(false, keys.map(String), hub);
      return Object.fromEntries(keys.map((k) => [k, hub.reading(String(k)) ?? null]));
    },
    'agentTasks.cancel': ({ id }) => {
      if (typeof id !== 'string') throw new Error('Choose a running AI task.');
      engine.agentTasks.cancel(id);
    },

    // ---- images & settings ----------------------------------------------------------------
    'images.upload': ({ base64, ext }) => store.putImage(Buffer.from(String(base64), 'base64'), String(ext || 'png')),
    'settings.update': ({ patch }) => {
      const s = checkSettingsPatch(patch);
      const settings = { ...cfg().settings, ...s };
      store.flush({ ...cfg(), settings });
      cfg().settings = settings;
      if (s.executeActions !== undefined) engine.setExecute(s.executeActions);
      engine.configChanged(false);
    },
  };
}
