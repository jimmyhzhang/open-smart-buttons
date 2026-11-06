// The engine binds devices to profiles: renders keys/touch zones, routes input to actions,
// and handles page/folder navigation. One Session per attached device (real or simulated).

import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import type { StreamDeckDevice } from '../device/streamdeck.ts';
import type { DeviceManager } from '../device/manager.ts';
import type { ActionInstance, Appearance, DeviceSummary, Page, Profile } from '../shared/types.ts';
import { keyCount, lcdZoneWidth } from '../protocol/models.ts';
import { ACTION_MAP, hasSilentVolumeIcon, type ActionCtx, type ActionDef } from './actions.ts';
import { createPlatform, PermissionError, type Platform } from './platform.ts';
import { infoBarMode, touchPointMode } from '../shared/neo-options.ts';
import { orientKey, renderInfoBar, renderKey, renderTouchZone, type KeyVisual, type TouchVisual } from '../render/renderer.ts';
import type { ResolvedIcon } from '../render/canvas.ts';
import type { Store } from './store.ts';
import { StateHub } from './state-hub.ts';
import { activeRule, stateKey } from '../shared/state-rules.ts';
import { externalActionMessage, isLocalAction } from '../shared/local-action-policy.ts';

const LONG_PRESS_MS = 500;

function someSavedAction(profiles: readonly Profile[], matches: (inst: ActionInstance) => boolean): boolean {
  const visited = new WeakSet<object>();
  const visit = (inst: ActionInstance | null): boolean => {
    if (!inst || typeof inst !== 'object' || visited.has(inst)) return false;
    visited.add(inst);
    if (matches(inst)) return true;
    return Array.isArray(inst.settings?.steps) && inst.settings.steps.some((step) => visit(step as ActionInstance));
  };
  return profiles.some((p) => Object.values(p.pages).some((pg) => [...pg.keys, ...pg.dials].some(visit)));
}

export interface EngineEvents {
  state: [];
  frame: [
    deviceId: string,
    f:
      | { target: 'key'; key: number; jpeg: Uint8Array }
      | { target: 'lcd'; x: number; y: number; width: number; height: number; jpeg: Uint8Array }
      | { target: 'infoBar'; jpeg: Uint8Array },
  ];
  log: [level: 'info' | 'warn' | 'error', msg: string];
  permission: [kind: 'accessibility' | 'automation', msg: string];
  report: [deviceId: string, dir: 'out' | 'feature' | 'in', bytes: Uint8Array];
  input: [deviceId: string, ev: { kind: string; index: number; down?: boolean; ticks?: number }];
}

export class Engine extends EventEmitter<EngineEvents> {
  readonly store: Store;
  readonly manager: DeviceManager;
  readonly localOnly: boolean;
  private readonly forceDryRun: boolean;
  platform: Platform;
  private readonly simulatorPlatform = createPlatform(false, (m) => this.log('info', `[dry-run] ${m}`));
  readonly sessions = new Map<string, Session>();
  /** Runtime state per action instance id (counter values, toggles, volume...). */
  readonly runtime = new Map<string, Record<string, any>>();
  private readonly simulatorRuntime = new Map<string, Record<string, any>>();
  /** Computer state read for state rules, shared by every device. */
  readonly states = new StateHub(() => this.platform);
  private readonly simulatorStates = new StateHub(() => this.simulatorPlatform);

  constructor(store: Store, manager: DeviceManager, localOnly = false, forceDryRun = false) {
    super();
    this.store = store;
    this.manager = manager;
    this.localOnly = localOnly;
    this.forceDryRun = forceDryRun;
    this.platform = this.makePlatform(store.config.settings.executeActions);
    manager.on('attach', (d) => this.attach(d));
    manager.on('detach', (d) => this.detach(d));
    manager.on('changed', () => this.emit('state'));
  }

  log(level: 'info' | 'warn' | 'error', msg: string): void {
    this.emit('log', level, msg);
    if (level !== 'info') console[level === 'warn' ? 'warn' : 'error'](msg);
  }

  setExecute(execute: boolean): void {
    this.store.config.settings.executeActions = execute;
    this.platform = this.makePlatform(execute);
    this.states.reset();
    void this.refreshStates(true, [], this.states);
  }

  private makePlatform(execute: boolean): Platform {
    return createPlatform(execute && !this.forceDryRun, (m) => this.log('info', `[dry-run] ${m}`));
  }

  platformFor(dev: StreamDeckDevice): Platform {
    return this.localOnly && dev.kind === 'sim' ? this.simulatorPlatform : this.platform;
  }

  stateHubFor(dev: StreamDeckDevice): StateHub {
    return this.localOnly && dev.kind === 'sim' ? this.simulatorStates : this.states;
  }

  assertLocal(action: ActionInstance, platform: Platform): void {
    if (this.localOnly && platform.canExecute && !isLocalAction(action)) throw new Error(externalActionMessage);
  }

  /**
   * Read the state that visible state rules use and redraw the buttons whose look depends on what
   * changed. Forced after a press, so a button that changes the state shows the effect at once.
   */
  refreshStates(force = false, extra: Iterable<string> = [], hub = this.states): Promise<void> {
    const keys = new Set<string>(extra);
    for (const s of this.sessions.values()) if (s.stateHub === hub) s.collectStateKeys(keys);
    if (!keys.size) return Promise.resolve();
    return hub.refresh(keys, force).then((changed) => {
      const volume = hub.values.get('volume');
      const muted = hub.values.get('muted');
      for (const session of this.sessions.values()) {
        if (session.stateHub !== hub) continue;
        if (keys.has('volume') && keys.has('muted') && typeof volume === 'number' && typeof muted === 'boolean') {
          session.updateVolumeKeys({ volume, muted });
        }
        if (changed.size) session.updateStateKeys(changed);
      }
    });
  }

  /** Share one sample across all visible volume keys. Read again after a volume action finishes. */
  refreshVolumeKeys(afterChange = false, hub = this.states): Promise<void> {
    return this.refreshStates(afterChange, ['volume', 'muted'], hub);
  }

  stateFor(id: string, dev?: StreamDeckDevice): Record<string, any> {
    const runtime = this.localOnly && dev?.kind === 'sim' ? this.simulatorRuntime : this.runtime;
    let s = runtime.get(id);
    if (!s) {
      s = {};
      runtime.set(id, s);
    }
    return s;
  }

  hasSavedAction(id: string): boolean {
    return someSavedAction(this.store.config.profiles, (inst) => inst.id === id);
  }

  private bindingKey(dev: StreamDeckDevice): string {
    return dev.kind === 'sim' ? `sim:${dev.model.id}` : dev.serial || dev.transport.info.path;
  }

  private attach(dev: StreamDeckDevice): void {
    const key = this.bindingKey(dev);
    let profile = this.store.profile(this.store.config.deviceProfiles[key] ?? '');
    if (!profile || profile.modelId !== dev.model.id) profile = this.store.profileForModel(dev.model.id);
    this.store.config.deviceProfiles[key] = profile.id;
    const s = new Session(this, dev, profile.id);
    this.sessions.set(dev.id, s);
    dev.on('frame', (f) => {
      if (f.target === 'key') this.emit('frame', dev.id, { target: 'key', key: f.key, jpeg: f.image });
      else if (f.target === 'infoBar') this.emit('frame', dev.id, { target: 'infoBar', jpeg: f.image });
      else this.emit('frame', dev.id, { target: 'lcd', ...f.rect, jpeg: f.image });
    });
    dev.on('report', (dir, b) => this.emit('report', dev.id, dir, b));
    void (async () => {
      await dev.setBrightness(this.store.config.settings.defaultBrightness);
      await dev.setSleepDelay(this.store.config.settings.sleepDelay);
      s.start();
    })().catch((e) => this.log('error', `init ${dev.id}: ${(e as Error).message}`));
    this.log('info', `${dev.kind === 'sim' ? 'Simulator' : 'Device'} connected: ${dev.model.name} ${dev.serial} (fw ${dev.firmware})`);
    this.emit('state');
  }

  private detach(dev: StreamDeckDevice): void {
    const s = this.sessions.get(dev.id);
    s?.dispose();
    this.sessions.delete(dev.id);
    this.log('info', `Disconnected: ${dev.model.name} ${dev.serial}`);
    this.emit('state');
  }

  /** Call after any config mutation. */
  configChanged(save = true): void {
    if (save) this.store.save();
    const retained = new Set<string>();
    someSavedAction(this.store.config.profiles, (inst) => { retained.add(inst.id); return false; });
    for (const runtime of [this.runtime, this.simulatorRuntime]) {
      for (const id of runtime.keys()) if (!retained.has(id)) runtime.delete(id);
    }
    for (const s of this.sessions.values()) s.onConfigChanged(retained);
    this.emit('state');
  }

  setSessionProfile(deviceId: string, profileId: string): void {
    const s = this.sessions.get(deviceId);
    const p = this.store.profile(profileId);
    if (!s || !p) throw new Error('No such device/profile');
    if (p.modelId !== s.dev.model.id) throw new Error(`Profile is for a different model (${p.modelId})`);
    this.store.config.deviceProfiles[this.bindingKey(s.dev)] = profileId;
    s.setProfile(profileId);
    this.store.save();
    this.emit('state');
  }

  summaries(): DeviceSummary[] {
    return [...this.sessions.values()].map((s) => s.summary());
  }

  resolveImage(id: string | null | undefined): string | null {
    return id ? this.store.imagePath(id) : null;
  }

  /** Run an action as if its key was pressed (Inspector "Test" button). */
  async testAction(deviceId: string, kind: 'key' | 'dial', index: number): Promise<void> {
    const s = this.sessions.get(deviceId);
    if (!s) throw new Error('No session');
    await s.testPress({ kind, index });
  }
}

type Slot = { kind: 'key' | 'dial'; index: number };

export class Session {
  readonly engine: Engine;
  readonly dev: StreamDeckDevice;
  get platform(): Platform { return this.engine.platformFor(this.dev); }
  get stateHub(): StateHub { return this.engine.stateHubFor(this.dev); }
  profileId: string;
  pageId = '';
  stack: string[] = [];
  private keyHash: string[] = [];
  private zoneHash: string[] = [];
  private pressedKeys = new Set<number>();
  private pressedDials = new Set<number>();
  private keyActions = new Map<number, ActionInstance>();
  private dialActions = new Map<number, ActionInstance>();
  private downAt = new Map<string, number>();
  private longTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private overlays = new Map<string, { kind: 'ok' | 'alert'; until: number }>();
  private liveTimer: ReturnType<typeof setInterval> | null = null;
  private renderSeq = new Map<string, number>();
  private asleep = false;
  private brightnessBeforeSleep = 0;
  private appeared = new Set<string>();
  private touchPointColor: number | null = null;
  private touchPointVersion = 0;
  private disposed = false;

  constructor(engine: Engine, dev: StreamDeckDevice, profileId: string) {
    this.engine = engine;
    this.dev = dev;
    this.profileId = profileId;
    const p = this.profile();
    this.pageId = p?.pageOrder[0] ?? '';
    dev.on('keyDown', (k) => this.handleKey(k, true));
    dev.on('keyUp', (k) => this.handleKey(k, false));
    dev.on('dialDown', (d) => this.handleDialPress(d, true));
    dev.on('dialUp', (d) => this.handleDialPress(d, false));
    dev.on('dialRotate', (d, t) => this.handleRotate(d, t));
    dev.on('touch', (e) => this.handleTouch(e));
    // Neo touch points: by default left = previous page, right = next page (Elgato's
    // behavior); each profile can repurpose them.
    dev.on('touchPointDown', (i) => {
      if (this.wake()) return;
      this.engine.emit('input', this.dev.id, { kind: 'touchpoint', index: i, down: true });
      this.touchPoint(i);
    });
    dev.on('touchPointUp', (i) => this.engine.emit('input', this.dev.id, { kind: 'touchpoint', index: i, down: false }));
  }

  private touchPoint(i: number): void {
    const mode = touchPointMode(this.profile()?.neo?.touchPoints);
    const left = i === 0;
    const p = this.platform;
    if (this.engine.localOnly && p.canExecute && mode === 'media') {
      this.engine.log('warn', externalActionMessage);
      return;
    }
    const op: Promise<void> | null = mode === 'pages' ? (this.cyclePage(left ? -1 : 1), null)
      : mode === 'media' ? p.media(left ? 'previous' : 'next')
      : mode === 'volume' ? p.media(left ? 'voldown' : 'volup')
      : mode === 'spaces' ? p.hotkey({ key: left ? 'Left' : 'Right', ctrl: true })
      : null;
    op?.catch((e) => this.engine.log('warn', `touch point: ${(e as Error).message}`));
  }

  start(): void {
    if (this.disposed || !this.dev.connected || this.liveTimer) return;
    this.renderAll(true);
    this.liveTimer = setInterval(() => this.tickLive(), 1000);
    this.liveTimer.unref?.();
  }

  dispose(): void {
    this.disposed = true;
    if (this.liveTimer) clearInterval(this.liveTimer);
    this.liveTimer = null;
    for (const t of this.longTimers.values()) clearTimeout(t);
    this.longTimers.clear();
    this.keyActions.clear();
    this.dialActions.clear();
  }

  profile(): Profile | undefined {
    return this.engine.store.profile(this.profileId);
  }
  page(): Page | undefined {
    return this.profile()?.pages[this.pageId];
  }

  summary(): DeviceSummary {
    const sim = this.engine.manager.simFor(this.dev);
    const m = this.dev.model;
    return {
      id: this.dev.id,
      kind: this.dev.kind,
      canExecute: this.platform.canExecute,
      modelId: m.id,
      modelName: m.name,
      serial: this.dev.serial,
      firmware: this.dev.firmware,
      path: this.dev.transport.info.path,
      brightness: this.dev.brightness,
      sleepDelay: this.dev.sleepDelay,
      columns: m.columns,
      rows: m.rows,
      encoders: m.encoders,
      lcd: m.lcd,
      touchPoints: m.touchPoints,
      infoBar: m.infoBar,
      keyPx: m.keyImage.width,
      profileId: this.profileId,
      pageId: this.pageId,
      stack: [...this.stack],
      sim: sim ? { asleep: sim.fb.asleep || this.asleep, stats: { ...sim.stats } } : undefined,
      touchPointColors: sim ? [...sim.fb.touchPoints] : undefined,
    };
  }

  // ---- navigation -------------------------------------------------------------------------------

  setProfile(id: string): void {
    this.profileId = id;
    this.stack = [];
    this.pageId = this.profile()?.pageOrder[0] ?? '';
    this.onPageChanged();
  }

  setPage(id: string): void {
    const p = this.profile();
    if (!p?.pages[id]) return;
    if (p.pages[id]!.parentId) {
      // Opening a folder directly (from the editor): build the stack from its ancestry.
      const chain: string[] = [];
      let cur: string | null | undefined = p.pages[id]!.parentId;
      while (cur && p.pages[cur]) {
        chain.unshift(cur);
        cur = p.pages[cur]!.parentId ?? null;
      }
      this.stack = chain;
    } else this.stack = [];
    this.pageId = id;
    this.onPageChanged();
  }

  private onPageChanged(): void {
    for (const t of this.longTimers.values()) clearTimeout(t);
    this.longTimers.clear();
    this.pressedKeys.clear();
    this.appeared.clear();
    this.renderAll();
    this.engine.emit('state');
  }

  private api() {
    const self = this;
    return {
      nextPage: () => self.cyclePage(1),
      prevPage: () => self.cyclePage(-1),
      gotoPage: (id: string) => self.setPage(id),
      openFolder: (id: string) => {
        const p = self.profile();
        if (!p?.pages[id]) return;
        self.stack.push(self.pageId);
        self.pageId = id;
        self.onPageChanged();
      },
      back: () => {
        const prev = self.stack.pop();
        if (prev) {
          self.pageId = prev;
          self.onPageChanged();
        }
      },
      switchProfile: (id: string) => {
        try {
          self.engine.setSessionProfile(self.dev.id, id);
        } catch (e) {
          self.engine.log('warn', (e as Error).message);
        }
      },
      get brightness() {
        return self.dev.brightness;
      },
      setBrightness: (v: number) => {
        void self.dev.setBrightness(v);
        self.renderAll();
        self.engine.emit('state');
      },
      sleepDisplay: () => self.sleep(),
      pageInfo: () => {
        const p = self.profile();
        const order = p?.pageOrder ?? [];
        const root = self.stack[0] ?? self.pageId;
        return { index: Math.max(0, order.indexOf(root)), count: order.length, name: self.page()?.name ?? '' };
      },
    };
  }

  cyclePage(dir: 1 | -1): void {
    const p = this.profile();
    if (!p || !p.pageOrder.length) return;
    const root = this.stack[0] ?? this.pageId;
    const i = p.pageOrder.indexOf(root);
    const next = p.pageOrder[(i + dir + p.pageOrder.length) % p.pageOrder.length]!;
    this.stack = [];
    this.pageId = next;
    this.onPageChanged();
  }

  private sleep(): void {
    if (this.asleep) return;
    this.asleep = true;
    this.brightnessBeforeSleep = this.dev.brightness || 70;
    void this.dev.setBrightness(0);
    this.engine.emit('state');
  }

  /** Returns true if the event was consumed to wake the device. */
  private wake(): boolean {
    if (!this.asleep) return false;
    this.asleep = false;
    void this.dev.setBrightness(this.brightnessBeforeSleep);
    this.engine.emit('state');
    return true;
  }

  // ---- input --------------------------------------------------------------------------------------

  private ctx(inst: ActionInstance, controller: 'key' | 'dial', slot: Slot | null, platform = this.platform): ActionCtx {
    const self = this;
    const alive = () => !self.disposed && self.engine.hasSavedAction(inst.id);
    const ownsSlot = () => slot && (slot.kind === 'key' ? self.page()?.keys[slot.index] : self.page()?.dials[slot.index])?.id === inst.id;
    return {
      instance: inst,
      settings: inst.settings,
      state: this.engine.stateFor(inst.id, this.dev),
      platform,
      session: this.api(),
      controller,
      refreshVolumeKeys: () => self.engine.refreshVolumeKeys(true, self.stateHub),
      refresh: () => {
        if (!alive()) return;
        if (slot && ownsSlot()) self.renderSlot(slot);
        else self.renderAll();
      },
      showOk: () => alive() && ownsSlot() && self.flash(slot!, 'ok'),
      showAlert: () => alive() && ownsSlot() && self.flash(slot!, 'alert'),
      log: (m) => self.engine.log('info', m),
      runInstance: async (child) => {
        if (platform !== self.platform || !alive() || !self.engine.hasSavedAction(child.id)) return;
        const def = ACTION_MAP.get(child.type);
        if (!def?.keyDown) return;
        const c = self.ctx(child, 'key', null, platform);
        self.engine.assertLocal(child, c.platform);
        await def.keyDown(c);
        if (platform === self.platform && alive() && self.engine.hasSavedAction(child.id)) await def.keyUp?.(c, 0);
      },
    };
  }

  /** `pressed`: the user pressed it, so read state again afterwards (it may have changed it). */
  private run(slot: Slot, inst: ActionInstance, fn: (def: ActionDef, c: ActionCtx) => unknown, pressed = false): void {
    if (this.disposed || !this.engine.hasSavedAction(inst.id)) return;
    const def = ACTION_MAP.get(inst.type);
    if (!def) return;
    const c = this.ctx(inst, slot.kind, slot);
    const settled = () => {
      if (pressed && !this.disposed && !(slot.kind === 'key' && inst.type === 'system.volume')) void this.engine.refreshStates(true, [], this.stateHub);
    };
    try {
      this.engine.assertLocal(inst, c.platform);
      const r = fn(def, c);
      if (r && typeof (r as Promise<void>).then === 'function') {
        (r as Promise<void>).catch((e) => this.fail(def.meta.name, slot, inst, e)).finally(settled);
      } else settled();
    } catch (e) {
      this.fail(def.meta.name, slot, inst, e);
      settled();
    }
  }

  /** Explicit tests await the same action handlers and propagate runtime failures to the caller. */
  async testPress(slot: Slot): Promise<void> {
    const inst = (slot.kind === 'key' ? this.page()?.keys : this.page()?.dials)?.[slot.index];
    const def = inst && ACTION_MAP.get(inst.type);
    if (this.disposed || !inst || !def) throw new Error('Select an existing action to test.');
    const state = this.engine.stateFor(inst.id, this.dev);
    if (state.testing || state.running) throw new Error('This action is already running.');
    if (!this.ready(slot, inst)) throw new Error('Complete the required action settings before testing.');
    state.testing = true;
    const c = this.ctx(inst, slot.kind, slot);
    this.engine.emit('input', this.dev.id, { kind: slot.kind, index: slot.index, down: true });
    try {
      this.engine.assertLocal(inst, c.platform);
      if (slot.kind === 'key') { await def.keyDown?.(c); await def.keyUp?.(c, 0); }
      else { await def.dialDown?.(c); await def.dialUp?.(c, 0); }
    } catch (error) {
      this.fail(def.meta.name, slot, inst, error);
      throw error;
    } finally {
      state.testing = false;
      this.engine.emit('input', this.dev.id, { kind: slot.kind, index: slot.index, down: false });
      if (slot.kind !== 'key' || inst.type !== 'system.volume') await this.engine.refreshStates(true, [], this.stateHub);
    }
  }

  /** A pressed button whose required settings are empty says so instead of failing silently. */
  private ready(slot: Slot, inst: ActionInstance): boolean {
    const def = ACTION_MAP.get(inst.type);
    const missing = def?.meta.fields.find((f) => f.required && (!f.controllers || f.controllers.includes(slot.kind)) && !String(inst.settings[f.key] ?? '').trim());
    if (!def || !missing) return true;
    const where = `${slot.kind === 'key' ? 'Key' : 'Dial'} ${slot.index + 1}`;
    this.fail(def.meta.name, slot, inst, new Error(`${where} isn't set up yet: choose “${missing.label}” (select it, then Configure action).`));
    return false;
  }

  private fail(name: string, slot: Slot, inst: ActionInstance, e: unknown): void {
    if (this.disposed || !this.engine.hasSavedAction(inst.id)) return;
    const msg = `${name}: ${(e as Error).message}`;
    if (e instanceof PermissionError) this.engine.emit('permission', e.permission, msg);
    this.engine.log('error', msg);
    const current = slot.kind === 'key' ? this.page()?.keys[slot.index] : this.page()?.dials[slot.index];
    if (current?.id === inst.id) this.flash(slot, 'alert');
  }

  handleKey(k: number, down: boolean): void {
    if (this.disposed) return;
    if (down && this.wake()) return;
    this.engine.emit('input', this.dev.id, { kind: 'key', index: k, down });
    const inst = this.page()?.keys[k];
    const slot: Slot = { kind: 'key', index: k };
    const id = `k${k}`;
    if (down) {
      this.pressedKeys.add(k);
      if (inst) this.keyActions.set(k, inst);
      else this.keyActions.delete(k);
      this.downAt.set(id, Date.now());
      if (inst) {
        const def = ACTION_MAP.get(inst.type);
        if (def?.longPress) {
          this.longTimers.set(id, setTimeout(() => {
            this.longTimers.delete(id);
            this.run(slot, inst, (d, c) => d.longPress?.(c));
          }, LONG_PRESS_MS));
        }
        if (this.ready(slot, inst)) this.run(slot, inst, (d, c) => d.keyDown?.(c), true);
      }
    } else {
      const pressed = this.keyActions.get(k);
      this.keyActions.delete(k);
      if (!this.pressedKeys.has(k) && !pressed) return;
      this.pressedKeys.delete(k);
      const held = Date.now() - (this.downAt.get(id) ?? Date.now());
      const t = this.longTimers.get(id);
      if (t) clearTimeout(t);
      this.longTimers.delete(id);
      this.downAt.delete(id);
      if (pressed) this.run(slot, pressed, (d, c) => d.keyUp?.(c, held));
    }
    if (this.engine.store.config.settings.pressFeedback) this.renderSlot(slot);
  }

  handleDialPress(d: number, down: boolean): void {
    if (this.disposed) return;
    if (down && this.wake()) return;
    this.engine.emit('input', this.dev.id, { kind: 'dial', index: d, down });
    const inst = this.page()?.dials[d];
    const slot: Slot = { kind: 'dial', index: d };
    const id = `d${d}`;
    if (down) {
      this.pressedDials.add(d);
      if (inst) this.dialActions.set(d, inst);
      else this.dialActions.delete(d);
      this.downAt.set(id, Date.now());
      if (inst) this.run(slot, inst, (def, c) => def.dialDown?.(c), true);
    } else {
      this.pressedDials.delete(d);
      const pressed = this.dialActions.get(d);
      this.dialActions.delete(d);
      const held = Date.now() - (this.downAt.get(id) ?? Date.now());
      this.downAt.delete(id);
      if (pressed) this.run(slot, pressed, (def, c) => def.dialUp?.(c, held));
    }
    this.renderSlot(slot);
  }

  private handleRotate(d: number, ticks: number): void {
    if (this.disposed || this.wake()) return;
    this.engine.emit('input', this.dev.id, { kind: 'rotate', index: d, ticks });
    const inst = this.page()?.dials[d];
    if (inst) this.run({ kind: 'dial', index: d }, inst, (def, c) => def.dialRotate?.(c, ticks));
  }

  private handleTouch(e: { type: 'tap' | 'long' | 'swipe'; x: number; y: number; x2?: number; y2?: number; zone: number }): void {
    if (this.disposed || this.wake()) return;
    this.engine.emit('input', this.dev.id, { kind: `touch-${e.type}`, index: e.zone });
    if (e.type === 'swipe') {
      const dx = (e.x2 ?? e.x) - e.x;
      if (Math.abs(dx) >= 60 && this.engine.store.config.settings.swipeChangesPages) this.cyclePage(dx < 0 ? 1 : -1);
      return;
    }
    const inst = this.page()?.dials[e.zone];
    if (!inst) return;
    const slot: Slot = { kind: 'dial', index: e.zone };
    const def = ACTION_MAP.get(inst.type);
    if (e.type === 'tap') {
      if (def?.touchTap) this.run(slot, inst, (d, c) => d.touchTap?.(c), true);
      else if (def?.dialDown) this.run(slot, inst, (d, c) => d.dialDown?.(c), true);
      else if (def?.keyDown) this.run(slot, inst, (d, c) => d.keyDown?.(c), true);
    } else if (def?.touchLong) this.run(slot, inst, (d, c) => d.touchLong?.(c));
    else if (def?.longPress) this.run(slot, inst, (d, c) => d.longPress?.(c));
  }

  private flash(slot: Slot, kind: 'ok' | 'alert'): void {
    const k = `${slot.kind}${slot.index}`;
    this.overlays.set(k, { kind, until: Date.now() + 1100 });
    this.renderSlot(slot);
    setTimeout(() => {
      const o = this.overlays.get(k);
      if (o && o.until <= Date.now()) {
        this.overlays.delete(k);
        this.renderSlot(slot);
      }
    }, 1150);
  }

  // ---- rendering --------------------------------------------------------------------------------

  onConfigChanged(retained: ReadonlySet<string>): void {
    for (const id of this.appeared) if (!retained.has(id)) this.appeared.delete(id);
    if (!this.profile()) {
      const p = this.engine.store.profileForModel(this.dev.model.id);
      this.profileId = p.id;
    }
    const prof = this.profile()!;
    if (!prof.pages[this.pageId]) {
      this.stack = [];
      this.pageId = prof.pageOrder[0] ?? '';
    }
    this.renderAll();
  }

  renderAll(force = false): void {
    if (this.disposed || !this.dev.connected) return;
    if (force) {
      this.keyHash = [];
      this.zoneHash = [];
      this.infoHash = '';
      this.touchPointColor = null; // Initial connection and the forced repaint after a device reset.
    }
    const n = keyCount(this.dev.model);
    for (let i = 0; i < n; i++) this.renderSlot({ kind: 'key', index: i });
    for (let i = 0; i < this.dev.model.encoders; i++) this.renderSlot({ kind: 'dial', index: i });
    this.renderInfoBar();
    if (this.dev.model.touchPoints) {
      const mode = touchPointMode(this.profile()?.neo?.touchPoints);
      const many = (this.profile()?.pageOrder.length ?? 0) > 1 && !this.stack.length;
      // Lit when pressing them does something.
      const color = mode === 'none' ? 0 : mode !== 'pages' || many ? 90 : 0;
      if (color !== this.touchPointColor) {
        this.touchPointColor = color; // Coalesce the same target while its reports are still queued.
        const version = ++this.touchPointVersion;
        void Promise.all(Array.from({ length: this.dev.model.touchPoints }, (_, i) => this.dev.setTouchPointColor(i, color, color, color))).catch((e) => {
          if (version === this.touchPointVersion) this.touchPointColor = null;
          if (this.dev.connected) this.engine.log('warn', `touch points: ${(e as Error).message}`);
        });
      }
    }
    // Fire appear hooks (e.g. read current system volume) once per page visit.
    const page = this.page();
    void this.engine.refreshStates(false, [], this.stateHub);
    for (const inst of [...(page?.keys ?? []), ...(page?.dials ?? [])]) {
      if (!inst || this.appeared.has(inst.id)) continue;
      this.appeared.add(inst.id);
      const def = ACTION_MAP.get(inst.type);
      if (def?.appear) {
        const isDial = page!.dials.includes(inst);
        const slot: Slot = isDial ? { kind: 'dial', index: page!.dials.indexOf(inst) } : { kind: 'key', index: page!.keys.indexOf(inst) };
        this.run(slot, inst, (d, c) => d.appear?.(c));
      }
    }
  }

  private infoHash = '';
  private infoSeq = 0;
  renderInfoBar(): void {
    const ib = this.dev.model.infoBar;
    if (!ib || this.disposed || !this.dev.connected) return;
    const d = new Date();
    const prof = this.profile();
    const order = prof?.pageOrder ?? [];
    const root = this.stack[0] ?? this.pageId;
    const v = {
      time: d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }),
      date: d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }),
      pageName: this.page()?.name ?? '',
      pageIndex: Math.max(0, order.indexOf(root)),
      pageCount: order.length,
      inFolder: this.stack.length > 0,
      mode: infoBarMode(prof?.neo?.infoBar),
    };
    const hash = JSON.stringify(v);
    if (hash === this.infoHash) return;
    const seq = ++this.infoSeq;
    void (async () => {
      try {
        const up = await renderInfoBar(v, ib.width, ib.height);
        const native = await orientKey(up, ib.width, true, true, ib.height);
        if (seq !== this.infoSeq) return;
        this.infoHash = hash;
        await this.dev.setInfoBarImage(native, up);
      } catch (e) {
        if (this.dev.connected) this.engine.log('error', `render info bar: ${(e as Error).message}`);
      }
    })();
  }

  private tickLive(): void {
    this.renderInfoBar();
    const page = this.page();
    if (!page) return;
    void this.engine.refreshStates(false, [], this.stateHub);
    page.keys.forEach((inst, i) => {
      if (inst && ACTION_MAP.get(inst.type)?.live) this.renderSlot({ kind: 'key', index: i });
    });
    page.dials.forEach((inst, i) => {
      if (inst && ACTION_MAP.get(inst.type)?.live) this.renderSlot({ kind: 'dial', index: i });
    });
  }

  updateVolumeKeys(snapshot: { volume: number; muted: boolean }): void {
    if (this.disposed || this.asleep || !this.dev.connected) return;
    this.page()?.keys.forEach((action, index) => {
      if (action?.type !== 'system.volume') return;
      const state = this.engine.stateFor(action.id, this.dev);
      if (state.volume === snapshot.volume && state.muted === snapshot.muted) return;
      state.volume = snapshot.volume;
      state.muted = snapshot.muted;
      this.renderSlot({ kind: 'key', index });
    });
  }

  /** The state keys this device's visible buttons follow. Nothing while the display sleeps. */
  collectStateKeys(into: Set<string>): void {
    if (this.disposed || this.asleep || !this.dev.connected) return;
    const page = this.page();
    if (page?.keys.some(hasSilentVolumeIcon)) {
      into.add('volume');
      into.add('muted');
    }
    for (const inst of [...(page?.keys ?? []), ...(page?.dials ?? [])]) for (const rule of inst?.stateRules ?? []) into.add(stateKey(rule));
  }

  updateStateKeys(changed: ReadonlySet<string>): void {
    const follows = (inst: ActionInstance | null | undefined) => !!inst?.stateRules?.some((r) => changed.has(stateKey(r)));
    this.page()?.keys.forEach((inst, index) => { if (follows(inst)) this.renderSlot({ kind: 'key', index }); });
    this.page()?.dials.forEach((inst, index) => { if (follows(inst)) this.renderSlot({ kind: 'dial', index }); });
  }

  private resolveIcon(ap: Appearance, def: ActionDef | undefined, dynIcon?: string): ResolvedIcon {
    // An icon the user picked always wins. With no pick, the action's live state icon (e.g. muted) or its
    // default icon is used.
    const icon = ap.icon;
    if (!icon) {
      if (dynIcon) return { kind: 'lucide', name: dynIcon };
      return def ? { kind: 'lucide', name: def.meta.icon } : { kind: 'none' };
    }
    if (icon.kind === 'image') {
      const p = this.engine.resolveImage(icon.id);
      return p ? { kind: 'image', path: p } : { kind: 'none' };
    }
    return icon;
  }

  keyVisual(index: number): KeyVisual | null {
    const inst = this.page()?.keys[index];
    if (!inst) return null;
    const def = ACTION_MAP.get(inst.type);
    const dyn = def?.key?.(this.ctx(inst, 'key', { kind: 'key', index })) ?? {};
    const ap: Appearance = { ...inst.appearance, ...(dyn.state ? inst.states?.[dyn.state] ?? {} : {}) };
    // A matching state rule is the user's own choice, so it wins over the action's dynamic look.
    const rule = activeRule(inst.stateRules, this.stateHub.values);
    const ov = this.overlays.get(`key${index}`);
    return {
      bg: rule?.bg || ap.bg || '#000000',
      bgImage: this.engine.resolveImage(ap.bgImage ?? null),
      icon: rule?.icon ? this.resolveIcon({ icon: rule.icon }, def) : dyn.iconOverride ? { kind: 'lucide', name: dyn.iconOverride } : this.resolveIcon(ap, def, dyn.icon),
      iconColor: ap.iconColor || '#ffffff',
      title: rule?.title ?? dyn.title ?? ap.title ?? '',
      showTitle: rule?.title ? true : ap.showTitle !== false,
      titleColor: ap.titleColor || '#ffffff',
      titleSize: ap.titleSize || 15,
      titleAlign: ap.titleAlign || 'bottom',
      value: dyn.value,
      progress: dyn.progress ?? null,
      pressed: this.engine.store.config.settings.pressFeedback && this.pressedKeys.has(index),
      overlay: ov && ov.until > Date.now() ? ov.kind : null,
    };
  }

  zoneVisual(index: number): TouchVisual {
    const page = this.page();
    const inst = page?.dials[index];
    const stripPath = this.engine.resolveImage(page?.touchBg ?? null);
    const stripBg = stripPath ? { path: stripPath, index, count: this.dev.model.encoders } : null;
    if (!inst) return { layout: 'icon', bg: '#000', accent: '#fff', title: '', icon: { kind: 'none' }, iconColor: '#fff', empty: true, stripBg };
    const def = ACTION_MAP.get(inst.type);
    const dyn = (def?.touch?.(this.ctx(inst, 'dial', { kind: 'dial', index })) ?? {}) as Partial<TouchVisual> & { iconOverride?: string };
    const rule = activeRule(inst.stateRules, this.stateHub.values);
    const ap: Appearance = { ...inst.appearance, ...(rule?.icon ? { icon: rule.icon } : {}), ...(rule?.bg ? { bg: rule.bg } : {}) };
    const ov = this.overlays.get(`dial${index}`);
    // A custom strip artwork (e.g. imported from Elgato) is the design: don't draw text over it.
    const artwork = !!ap.bgImage && dyn.indicator == null;
    return {
      layout: artwork ? 'canvas' : (dyn.layout ?? (dyn.indicator != null ? 'bar' : 'icon')),
      bg: ap.bg && ap.bg !== '#000000' ? ap.bg : '#000',
      accent: def?.meta.color ?? '#fff',
      title: rule?.title ?? (ap.showTitle === false ? '' : (dyn.title ?? (ap.title || def?.meta.name || ''))),
      value: artwork ? undefined : dyn.value,
      indicator: dyn.indicator ?? null,
      indicator2: dyn.indicator2 ?? null,
      icon: this.resolveIcon(ap, def, dyn.iconOverride),
      iconColor: ap.iconColor || '#ffffff',
      bgImage: this.engine.resolveImage(ap.bgImage ?? null),
      stripBg,
      pressed: this.pressedDials.has(index),
      overlay: ov && ov.until > Date.now() ? ov.kind : null,
    };
  }

  renderSlot(slot: Slot): void {
    if (this.disposed || !this.dev.connected) return;
    const k = `${slot.kind}${slot.index}`;
    const seq = (this.renderSeq.get(k) ?? 0) + 1;
    this.renderSeq.set(k, seq);
    void (async () => {
      try {
        if (slot.kind === 'key') {
          const v = this.keyVisual(slot.index);
          const hash = createHash('sha1').update(JSON.stringify(v)).digest('hex');
          if (this.keyHash[slot.index] === hash) return;
          const px = this.dev.model.keyImage.width;
          const jpeg = await renderKey(
            v ?? { bg: '#000', icon: { kind: 'none' }, iconColor: '#fff', title: '', showTitle: false, titleColor: '#fff', titleSize: 14, titleAlign: 'bottom' },
            px,
          );
          const ki = this.dev.model.keyImage;
          const native = await orientKey(jpeg, px, ki.flipX, ki.flipY);
          if (this.renderSeq.get(k) !== seq) return; // superseded
          this.keyHash[slot.index] = hash;
          await this.dev.setKeyImage(slot.index, native, native === jpeg ? undefined : jpeg);
        } else {
          if (!this.dev.model.lcd) return;
          const v = this.zoneVisual(slot.index);
          const hash = createHash('sha1').update(JSON.stringify(v)).digest('hex');
          if (this.zoneHash[slot.index] === hash) return;
          const w = lcdZoneWidth(this.dev.model);
          const jpeg = await renderTouchZone(v, w, this.dev.model.lcd.height);
          if (this.renderSeq.get(k) !== seq) return;
          this.zoneHash[slot.index] = hash;
          await this.dev.setLcdImage(this.dev.zoneRect(slot.index), jpeg);
        }
      } catch (e) {
        if (this.dev.connected) this.engine.log('error', `render ${k}: ${(e as Error).message}`);
      }
    })();
  }
}
