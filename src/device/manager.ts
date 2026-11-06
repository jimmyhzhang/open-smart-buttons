// Device discovery and lifecycle (the clone's equivalent of ESDHIDManager + ESDDeviceManager).
// Polls hidapi for Elgato devices (hot-plug), opens supported models, and hosts simulators.

import { EventEmitter } from 'node:events';
import { StreamDeckDevice } from './streamdeck.ts';
import { SimulatedStreamDeck, type SimOptions } from './sim-transport.ts';
import { listElgatoHid, loadNodeHid, nodeHidLoadError, openNodeHid } from './node-hid-transport.ts';
import type { HidDeviceInfo, HidTransport } from './transport.ts';
import { modelById, modelByProductId } from '../protocol/models.ts';

export interface DiscoveredDevice {
  info: HidDeviceInfo;
  modelId: string | null;
  modelName: string;
  supported: boolean;
  /** Set when the device is open. */
  deviceId?: string;
  error?: string;
}

export interface ManagerEvents {
  attach: [dev: StreamDeckDevice];
  detach: [dev: StreamDeckDevice];
  changed: [];
}
interface HidBackend { available(): Promise<boolean>; list(): Promise<HidDeviceInfo[]>; open(info: HidDeviceInfo): Promise<HidTransport> }

export class DeviceManager extends EventEmitter<ManagerEvents> {
  readonly devices = new Map<string, StreamDeckDevice>();
  readonly sims = new Map<string, SimulatedStreamDeck>();
  private discovered: DiscoveredDevice[] = [];
  private openPaths = new Map<string, StreamDeckDevice>();
  private opening = new Map<string, Promise<StreamDeckDevice>>();
  private reconnecting = new Map<string, Promise<StreamDeckDevice>>();
  private failedPaths = new Map<string, { error: string; at: number }>();
  private timer: ReturnType<typeof setInterval> | null = null;
  hidAvailable = false;
  /** Set when USB was requested but the native module could not load. */
  hidError: string | undefined;
  autoConnect = true;
  private readonly hid: HidBackend;

  constructor(hid: HidBackend = {
    available: async () => !!(await loadNodeHid()), list: listElgatoHid, open: openNodeHid,
  }) { super(); this.hid = hid; }

  async start(opts: { hid: boolean; pollMs?: number }): Promise<void> {
    if (opts.hid) {
      this.hidAvailable = await this.hid.available();
      this.hidError = this.hidAvailable ? undefined : (nodeHidLoadError() ?? 'USB device support is unavailable.');
      if (this.hidAvailable) {
        await this.scan();
        this.timer = setInterval(() => void this.scan().catch((e) => console.error('scan failed', e)), opts.pollMs ?? 1500);
      }
    }
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    const devs = [...this.devices.values()];
    await Promise.all(devs.map((d) => d.close()));
    for (const d of devs) this.detach(d);
  }

  list(): DiscoveredDevice[] {
    const sims: DiscoveredDevice[] = [...this.sims.values()].map((s) => {
      const dev = [...this.devices.values()].find((d) => d.transport === s);
      return { info: s.info, modelId: s.model.id, modelName: s.model.name, supported: true, deviceId: dev?.id };
    });
    return [...this.discovered, ...sims];
  }

  async scan(): Promise<void> {
    // --no-hid is an isolation boundary, including scans triggered by the UI.
    if (!this.hidAvailable) return;
    let infos: HidDeviceInfo[] = [];
    try {
      infos = await this.hid.list();
    } catch {
      return;
    }
    const seen = new Set(infos.map((i) => i.path));
    const next: DiscoveredDevice[] = [];
    const toConnect: HidDeviceInfo[] = [];
    for (const info of infos) {
      const model = modelByProductId(info.productId);
      const open = this.openPaths.get(info.path);
      const failed = this.failedPaths.get(info.path);
      const d: DiscoveredDevice = {
        info,
        modelId: model?.id ?? null,
        modelName: model?.name ?? `Unknown Elgato device (PID 0x${info.productId.toString(16).padStart(4, '0')})`,
        supported: !!model?.supported,
        deviceId: open?.id,
        error: failed?.error,
      };
      next.push(d);
      // Retry failed opens every 5 s (e.g. after the user quits the Elgato app).
      if (!open && model?.supported && this.autoConnect && (!failed || Date.now() - failed.at > 5000)) {
        toConnect.push(info);
      }
    }
    // Detach devices that vanished from enumeration.
    for (const [path, dev] of this.openPaths) {
      if (!seen.has(path)) this.detach(dev, path);
    }
    const changed = JSON.stringify(next) !== JSON.stringify(this.discovered);
    this.discovered = next;
    if (changed) this.emit('changed');
    // Connect after `discovered` is updated; failures are recorded, never thrown out of the scan loop.
    for (const info of toConnect) await this.connect(info.path).catch(() => {});
  }

  async connect(path: string): Promise<StreamDeckDevice> {
    if (!this.hidAvailable) throw new Error('USB is disabled in this instance. Use the main app for your physical Stream Deck.');
    const existing = this.openPaths.get(path);
    if (existing) return existing;
    const pending = this.opening.get(path);
    if (pending) return pending;
    const operation = this.openDevice(path);
    this.opening.set(path, operation);
    try { return await operation; }
    finally { this.opening.delete(path); }
  }

  private async openDevice(path: string): Promise<StreamDeckDevice> {
    const info = this.discovered.find((d) => d.info.path === path)?.info;
    if (!info) throw new Error('Device not found');
    const model = modelByProductId(info.productId);
    if (!model?.supported) throw new Error('Unsupported model');
    try {
      const t = await this.hid.open(info);
      const dev = new StreamDeckDevice(t, model);
      await dev.open();
      this.openPaths.set(path, dev);
      this.failedPaths.delete(path);
      this.register(dev, path);
      return dev;
    } catch (e) {
      const msg = (e as Error).message || String(e);
      this.failedPaths.set(path, {
        error: /exclusive|privilege|access|open/i.test(msg)
          ? 'This Stream Deck is already in use or cannot be opened. Another StreamDeckPlus instance, Elgato Stream Deck, or OpenDeck may own it. Use the connected instance or disconnect it there before retrying.'
          : msg,
        at: Date.now(),
      });
      this.emit('changed');
      throw new Error(this.failedPaths.get(path)!.error);
    }
  }

  async disconnect(deviceId: string): Promise<void> {
    const dev = this.devices.get(deviceId);
    if (!dev) return;
    const path = [...this.openPaths.entries()].find(([, d]) => d === dev)?.[0];
    if (path) this.failedPaths.set(path, { error: 'Disconnected by user', at: Date.now() + 1e12 });
    await dev.close();
    this.detach(dev, path);
  }

  /** Release our own handle before reopening; never try to seize another app's handle. */
  reconnect(deviceId: string): Promise<StreamDeckDevice> {
    const pending = this.reconnecting.get(deviceId);
    if (pending) return pending;
    const dev = this.devices.get(deviceId);
    if (!dev || dev.kind !== 'usb') return Promise.reject(new Error('Select a connected USB device to reconnect.'));
    const path = dev.transport.info.path;
    const operation = (async () => {
      await this.disconnect(deviceId);
      const connected = await this.connect(path);
      return connected;
    })();
    this.reconnecting.set(deviceId, operation);
    void operation.finally(() => this.reconnecting.delete(deviceId)).catch(() => {});
    return operation;
  }

  async addSimulator(modelId = 'plus', opts: SimOptions = {}): Promise<StreamDeckDevice> {
    const model = modelById(modelId);
    if (!model) throw new Error(`Unknown model ${modelId}`);
    const sim = new SimulatedStreamDeck(model, opts);
    this.sims.set(sim.info.path, sim);
    const dev = new StreamDeckDevice(sim, model);
    await dev.open();
    this.register(dev, sim.info.path);
    return dev;
  }

  async removeSimulator(deviceId: string): Promise<void> {
    const dev = this.devices.get(deviceId);
    if (!dev || dev.kind !== 'sim') return;
    this.sims.delete(dev.transport.info.path);
    await dev.close();
    this.detach(dev);
  }

  simFor(dev: StreamDeckDevice): SimulatedStreamDeck | null {
    return dev.transport instanceof SimulatedStreamDeck ? dev.transport : null;
  }

  private register(dev: StreamDeckDevice, path: string): void {
    this.devices.set(dev.id, dev);
    for (const entry of this.discovered) if (entry.info.path === path) { entry.deviceId = dev.id; delete entry.error; }
    dev.on('disconnect', () => {
      void dev.close();
      this.detach(dev, path);
    });
    this.emit('attach', dev);
    this.emit('changed');
  }

  private detach(dev: StreamDeckDevice, path?: string): void {
    if (!this.devices.has(dev.id)) return;
    this.devices.delete(dev.id);
    if (path) this.openPaths.delete(path);
    for (const entry of this.discovered) if (entry.deviceId === dev.id) { delete entry.deviceId; entry.error = path ? this.failedPaths.get(path)?.error : undefined; }
    if (dev.kind === 'sim') this.sims.delete(dev.transport.info.path);
    this.emit('detach', dev);
    this.emit('changed');
  }
}
