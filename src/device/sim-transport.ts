// Virtual Stream Deck at the HID-report level.
// It consumes exactly the output/feature reports a real device would receive (reassembling
// paged JPEG uploads into a framebuffer) and produces byte-identical input reports. The rest of
// the stack cannot tell it apart from hardware, which is what makes it a faithful simulator.

import { EventEmitter } from 'node:events';
import type { HidDeviceInfo, HidTransport } from './transport.ts';
import { ELGATO_VENDOR_ID, keyCount, type ModelInfo } from '../protocol/models.ts';
import {
  PageAssembler,
  ReportId,
  decodeFeatureSet,
  decodeInput,
  decodeOutputPage,
  encodeFirmwareReply,
  encodeSerialReply,
  type Rect,
} from '../protocol/reports.ts';

export interface SimFramebuffer {
  keys: (Uint8Array | null)[];
  /** LCD region writes in paint order; later entries draw over earlier ones. */
  lcd: { rect: Rect; image: Uint8Array }[];
  brightness: number;
  sleepDelay: number;
  asleep: boolean;
  touchPoints: string[];
  infoBar: Uint8Array | null;
}

export interface SimOptions {
  serial?: string;
  firmware?: string;
  /** Simulated USB time per 1024-byte page, in ms (default 0.25 = roughly what full-speed HID achieves). */
  pageLatencyMs?: number;
}

export class SimulatedStreamDeck extends EventEmitter implements HidTransport {
  readonly info: HidDeviceInfo;
  readonly model: ModelInfo;
  readonly fb: SimFramebuffer;
  private assembler = new PageAssembler();
  private dataCbs: ((d: Uint8Array) => void)[] = [];
  private errCbs: ((e: Error) => void)[] = [];
  private firmware: string;
  private latency: number;
  private lastActivity = Date.now();
  private sleepTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  /** Counters so the UI can show protocol traffic. */
  readonly stats = { outputReports: 0, featureReports: 0, inputReports: 0, bytesOut: 0 };

  constructor(model: ModelInfo, opts: SimOptions = {}) {
    super();
    this.model = model;
    const serial = opts.serial ?? `SIM${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
    this.firmware = opts.firmware ?? '1.01.000-sim';
    this.latency = opts.pageLatencyMs ?? 0.25;
    this.info = {
      path: `sim://${model.id}/${serial}`,
      vendorId: ELGATO_VENDOR_ID,
      productId: model.productIds[0]!,
      serialNumber: serial,
      product: `${model.name} (Simulator)`,
      manufacturer: 'Elgato',
      kind: 'sim',
    };
    this.fb = {
      keys: new Array(keyCount(model)).fill(null),
      lcd: [],
      brightness: 100,
      sleepDelay: 0,
      asleep: false,
      touchPoints: new Array(model.touchPoints).fill('#000000'),
      infoBar: null,
    };
    this.sleepTimer = setInterval(() => this.checkSleep(), 1000);
    this.sleepTimer.unref?.();
  }

  // ---- HidTransport (host side) ------------------------------------------------------------

  async write(data: Uint8Array): Promise<void> {
    this.assertOpen();
    this.stats.outputReports++;
    this.stats.bytesOut += data.length;
    if (this.latency > 0) await new Promise((r) => setTimeout(r, this.latency));
    const page = decodeOutputPage(data);
    const done = this.assembler.push(page);
    if (!done) return;
    if (done.target === 'infoBar') {
      this.fb.infoBar = done.image;
      this.emit('frame', { target: 'infoBar', image: done.image });
      return;
    }
    if (done.target === 'key') {
      if (done.key < this.fb.keys.length) {
        this.fb.keys[done.key] = done.image;
        this.emit('frame', { target: 'key', key: done.key, image: done.image });
      }
    } else {
      const r = done.rect;
      // Drop older writes the new region fully covers, so the paint list stays small.
      this.fb.lcd = this.fb.lcd.filter(
        (e) => !(e.rect.x >= r.x && e.rect.y >= r.y && e.rect.x + e.rect.width <= r.x + r.width && e.rect.y + e.rect.height <= r.y + r.height),
      );
      this.fb.lcd.push({ rect: r, image: done.image });
      this.emit('frame', { target: 'lcd', rect: r, image: done.image });
    }
  }

  async sendFeatureReport(data: Uint8Array): Promise<void> {
    this.assertOpen();
    this.stats.featureReports++;
    const f = decodeFeatureSet(data);
    if (f.cmd === 'brightness') this.fb.brightness = f.percent;
    else if (f.cmd === 'unknown' && f.code === 0x06) {
      const b = f.bytes;
      this.fb.touchPoints[(b[2] ?? 0) - keyCount(this.model)] = `#${[b[3], b[4], b[5]].map((x) => (x ?? 0).toString(16).padStart(2, '0')).join('')}`;
    }
    else if (f.cmd === 'sleepDelay') this.fb.sleepDelay = f.seconds;
    else if (f.cmd === 'reset') {
      this.fb.keys.fill(null);
      this.fb.lcd = [];
      this.emit('frame', { target: 'reset' });
    }
    this.emit('state', this.publicState());
  }

  async getFeatureReport(reportId: number, _length: number): Promise<Uint8Array> {
    this.assertOpen();
    if (reportId === ReportId.FeatureFirmware) return encodeFirmwareReply(this.firmware);
    if (reportId === ReportId.FeatureSerial) return encodeSerialReply(this.info.serialNumber ?? '');
    return new Uint8Array(32);
  }

  onData(cb: (d: Uint8Array) => void): void {
    this.dataCbs.push(cb);
  }
  onError(cb: (e: Error) => void): void {
    this.errCbs.push(cb);
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.sleepTimer) clearInterval(this.sleepTimer);
  }

  // ---- Device side: physical interaction -------------------------------------------------------

  /** Inject a raw input report (what the firmware would send). Validates it like the host would. */
  inject(report: Uint8Array): void {
    if (this.closed) return;
    const parsed = decodeInput(report, keyCount(this.model) + this.model.touchPoints, this.model.encoders);
    if (parsed.kind === 'unknown') throw new Error('Simulator: refusing malformed input report');
    this.lastActivity = Date.now();
    if (this.fb.asleep) {
      this.fb.asleep = false;
      this.emit('state', this.publicState());
    }
    this.stats.inputReports++;
    for (const cb of this.dataCbs) cb(report);
  }

  /** Simulate unplugging the cable. */
  unplug(): void {
    const err = new Error('could not read from HID device (simulated unplug)');
    this.closed = true;
    for (const cb of this.errCbs) cb(err);
  }

  publicState() {
    return {
      brightness: this.fb.brightness,
      sleepDelay: this.fb.sleepDelay,
      asleep: this.fb.asleep,
      touchPoints: [...this.fb.touchPoints],
      stats: { ...this.stats },
    };
  }

  private checkSleep(): void {
    if (!this.fb.sleepDelay || this.fb.asleep || this.closed) return;
    if (Date.now() - this.lastActivity > this.fb.sleepDelay * 1000) {
      this.fb.asleep = true;
      this.emit('state', this.publicState());
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('Simulated device is disconnected');
  }
}
