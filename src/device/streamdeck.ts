// High-level Stream Deck driver over a HidTransport (real or simulated).
// Mirrors the app's task queue design (ESDComm*Task): all writes are serialized, and a pending
// upload for the same key / LCD region is replaced instead of queued twice (coalescing).

import { EventEmitter } from 'node:events';
import type { HidTransport } from './transport.ts';
import { keyCount, lcdZoneWidth, type ModelInfo } from '../protocol/models.ts';
import {
  FEATURE_REPORT_SIZE,
  ReportId,
  decodeFirmware,
  decodeInput,
  decodeSerial,
  encodeBrightness,
  encodeKeyImagePages,
  encodeLcdPages,
  encodeReset,
  encodeSleepDelay,
  encodeTouchPointColor,
  encodeInfoBarPages,
  type Rect,
  type TouchType,
} from '../protocol/reports.ts';

export interface DeviceEvents {
  keyDown: [key: number];
  keyUp: [key: number];
  dialDown: [dial: number];
  dialUp: [dial: number];
  dialRotate: [dial: number, ticks: number];
  touchPointDown: [index: number];
  touchPointUp: [index: number];
  touch: [ev: { type: TouchType; x: number; y: number; x2?: number; y2?: number; zone: number }];
  /** Emitted for every image actually queued to the device (used for the UI mirror). */
  frame: [f: { target: 'key'; key: number; image: Uint8Array } | { target: 'lcd'; rect: Rect; image: Uint8Array } | { target: 'infoBar'; image: Uint8Array }];
  disconnect: [err?: Error];
  /** Raw report tap for the protocol inspector. */
  report: [dir: 'out' | 'feature' | 'in', bytes: Uint8Array];
}

interface Job {
  key: string;
  run: () => Promise<void>;
  waiters: { resolve: () => void; reject: (e: unknown) => void }[];
}

export class StreamDeckDevice extends EventEmitter<DeviceEvents> {
  readonly transport: HidTransport;
  readonly model: ModelInfo;
  serial = '';
  firmware = '';
  brightness = 100;
  sleepDelay = 0;
  connected = true;
  private keyStates: boolean[];
  private dialStates: boolean[];
  private queue: Job[] = [];
  private pumping = false;
  /** Last image per key/zone so a re-attached UI or a wake can repaint instantly. */
  readonly lastKeyImages: (Uint8Array | null)[];

  constructor(transport: HidTransport, model: ModelInfo) {
    super();
    this.transport = transport;
    this.model = model;
    this.keyStates = new Array(keyCount(model) + model.touchPoints).fill(false);
    this.dialStates = new Array(model.encoders).fill(false);
    this.lastKeyImages = new Array(keyCount(model)).fill(null);
    transport.onData((d) => this.handleInput(d));
    transport.onError((e) => this.handleDisconnect(e));
  }

  get id(): string {
    return `${this.model.id}:${this.serial || this.transport.info.path}`;
  }
  get kind(): 'usb' | 'sim' {
    return this.transport.info.kind;
  }

  async open(): Promise<void> {
    try {
      this.serial = decodeSerial(await this.transport.getFeatureReport(ReportId.FeatureSerial, FEATURE_REPORT_SIZE));
    } catch {
      this.serial = this.transport.info.serialNumber ?? '';
    }
    if (!this.serial) this.serial = this.transport.info.serialNumber ?? '';
    try {
      this.firmware = decodeFirmware(await this.transport.getFeatureReport(ReportId.FeatureFirmware, FEATURE_REPORT_SIZE));
    } catch {
      this.firmware = 'unknown';
    }
  }

  // ---- Output ---------------------------------------------------------------------------------

  /** `preview` is the upright image for the UI mirror when the device needs a flipped one. */
  setKeyImage(key: number, jpeg: Uint8Array, preview?: Uint8Array): Promise<void> {
    if (key < 0 || key >= keyCount(this.model)) return Promise.reject(new RangeError(`key ${key} out of range`));
    this.lastKeyImages[key] = preview ?? jpeg;
    this.emit('frame', { target: 'key', key, image: preview ?? jpeg });
    const pages = encodeKeyImagePages(key, jpeg, this.model.packetSize);
    return this.enqueue(`key:${key}`, async () => {
      for (const p of pages) {
        await this.transport.write(p);
        this.emit('report', 'out', p);
      }
    });
  }

  setLcdImage(rect: Rect, jpeg: Uint8Array): Promise<void> {
    const lcd = this.model.lcd;
    if (!lcd) return Promise.reject(new Error(`${this.model.name} has no LCD`));
    if (rect.x < 0 || rect.y < 0 || rect.x + rect.width > lcd.width || rect.y + rect.height > lcd.height) {
      return Promise.reject(new RangeError('LCD rect out of bounds'));
    }
    this.emit('frame', { target: 'lcd', rect, image: jpeg });
    const pages = encodeLcdPages(rect, jpeg, this.model.packetSize);
    return this.enqueue(`lcd:${rect.x},${rect.y},${rect.width},${rect.height}`, async () => {
      for (const p of pages) {
        await this.transport.write(p);
        this.emit('report', 'out', p);
      }
    });
  }

  /** Neo info bar. `preview` is the upright image for the UI mirror. */
  setInfoBarImage(jpeg: Uint8Array, preview?: Uint8Array): Promise<void> {
    if (!this.model.infoBar) return Promise.resolve();
    this.emit('frame', { target: 'infoBar', image: preview ?? jpeg });
    const pages = encodeInfoBarPages(jpeg, this.model.packetSize);
    return this.enqueue('infobar', async () => {
      for (const p of pages) {
        await this.transport.write(p);
        this.emit('report', 'out', p);
      }
    });
  }

  setTouchPointColor(index: number, r: number, g: number, b: number): Promise<void> {
    if (index < 0 || index >= this.model.touchPoints) return Promise.resolve();
    const rep = encodeTouchPointColor(keyCount(this.model) + index, r, g, b);
    return this.enqueue(`tp:${index}`, () => this.feature(rep));
  }

  setBrightness(percent: number): Promise<void> {
    this.brightness = Math.max(0, Math.min(100, Math.round(percent)));
    const r = encodeBrightness(this.brightness);
    return this.enqueue('brightness', () => this.feature(r));
  }

  setSleepDelay(seconds: number): Promise<void> {
    this.sleepDelay = Math.max(0, Math.floor(seconds));
    const r = encodeSleepDelay(this.sleepDelay);
    return this.enqueue('sleep', () => this.feature(r));
  }

  reset(): Promise<void> {
    this.lastKeyImages.fill(null);
    return this.enqueue(`reset:${Date.now()}`, () => this.feature(encodeReset()));
  }

  private async feature(r: Uint8Array): Promise<void> {
    await this.transport.sendFeatureReport(r);
    this.emit('report', 'feature', r);
  }

  /** Feed an input report as if it came from the hardware (UI "virtual press" on a real device). */
  injectInput(report: Uint8Array): void {
    this.handleInput(report);
  }

  /** Zone rect on the touch strip for a given encoder. */
  zoneRect(dial: number): Rect {
    const w = lcdZoneWidth(this.model);
    return { x: dial * w, y: 0, width: w, height: this.model.lcd?.height ?? 0 };
  }

  async close(): Promise<void> {
    this.connected = false;
    this.queue = [];
    await this.transport.close();
  }

  // ---- Queue ----------------------------------------------------------------------------------

  private enqueue(key: string, run: () => Promise<void>): Promise<void> {
    if (!this.connected) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const existing = this.queue.find((j) => j.key === key);
      if (existing) {
        // Coalesce: newer content replaces the pending upload; every caller settles together.
        existing.run = run;
        existing.waiters.push({ resolve, reject });
      } else {
        this.queue.push({ key, run, waiters: [{ resolve, reject }] });
      }
      void this.pump();
    });
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.length && this.connected) {
        const job = this.queue.shift()!;
        try {
          await job.run();
          job.waiters.forEach((w) => w.resolve());
        } catch (e) {
          job.waiters.forEach((w) => w.reject(e));
          if (!this.connected) break;
        }
      }
    } finally {
      this.pumping = false;
    }
  }

  // ---- Input ----------------------------------------------------------------------------------

  private handleInput(d: Uint8Array): void {
    if (this.listenerCount('report')) this.emit('report', 'in', d);
    const r = decodeInput(d, this.keyStates.length, this.model.encoders);
    switch (r.kind) {
      case 'keys': {
        const n = keyCount(this.model);
        r.states.forEach((s, i) => {
          if (s !== this.keyStates[i]) {
            this.keyStates[i] = s;
            if (i < n) this.emit(s ? 'keyDown' : 'keyUp', i);
            else this.emit(s ? 'touchPointDown' : 'touchPointUp', i - n);
          }
        });
        break;
      }
      case 'encoderPress':
        r.states.forEach((s, i) => {
          if (s !== this.dialStates[i]) {
            this.dialStates[i] = s;
            this.emit(s ? 'dialDown' : 'dialUp', i);
          }
        });
        break;
      case 'encoderRotate':
        r.deltas.forEach((t, i) => {
          if (t !== 0) this.emit('dialRotate', i, t);
        });
        break;
      case 'touch': {
        const w = lcdZoneWidth(this.model) || 1;
        const zone = Math.max(0, Math.min(this.model.encoders - 1, Math.floor(r.x / w)));
        this.emit('touch', { type: r.type, x: r.x, y: r.y, x2: r.x2, y2: r.y2, zone });
        break;
      }
      default:
        break;
    }
  }

  private handleDisconnect(err?: Error): void {
    if (!this.connected) return;
    this.connected = false;
    for (const j of this.queue.splice(0)) j.waiters.forEach((w) => w.resolve());
    this.emit('disconnect', err);
  }
}
