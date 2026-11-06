// Real USB transport on top of node-hid (hidapi). node-hid is an optional dependency: when it
// is missing (e.g. unsupported platform) the app still runs with simulators only.

import type { HidDeviceInfo, HidTransport } from './transport.ts';
import { ELGATO_VENDOR_ID } from '../protocol/models.ts';

type NodeHid = typeof import('node-hid');
let hidModule: NodeHid | null | undefined;
let hidLoadError: string | undefined;

/** Why USB support failed to load, so "missing" can be told apart from "disabled". */
export function nodeHidLoadError(): string | undefined {
  return hidLoadError;
}

export async function loadNodeHid(): Promise<NodeHid | null> {
  if (hidModule !== undefined) return hidModule;
  try {
    const mod = (await import('node-hid')) as any;
    hidModule = (typeof mod.devicesAsync === 'function' ? mod : mod.default) ?? null;
  } catch (error) {
    hidModule = null;
    hidLoadError = (error as Error).message || String(error);
  }
  return hidModule ?? null;
}

/** Enumerate Elgato HID interfaces. Dedupes multiple interfaces of one device, preferring usage page 0x0c. */
export async function listElgatoHid(): Promise<HidDeviceInfo[]> {
  const hid = await loadNodeHid();
  if (!hid) return [];
  const all = await hid.devicesAsync(ELGATO_VENDOR_ID, 0);
  const byKey = new Map<string, HidDeviceInfo>();
  for (const d of all) {
    if (!d.path) continue;
    const info: HidDeviceInfo = {
      path: d.path,
      vendorId: d.vendorId,
      productId: d.productId,
      serialNumber: d.serialNumber,
      product: d.product,
      manufacturer: d.manufacturer,
      usagePage: d.usagePage,
      usage: d.usage,
      kind: 'usb',
    };
    const key = `${d.productId}:${d.serialNumber ?? d.path}`;
    const prev = byKey.get(key);
    if (!prev || (prev.usagePage !== 0x0c && d.usagePage === 0x0c)) byKey.set(key, info);
  }
  return [...byKey.values()];
}

export async function openNodeHid(info: HidDeviceInfo): Promise<HidTransport> {
  const hid = await loadNodeHid();
  if (!hid) throw new Error('node-hid is not available on this system');
  const dev = await hid.HIDAsync.open(info.path);
  const dataCbs: ((d: Uint8Array) => void)[] = [];
  const errCbs: ((e: Error) => void)[] = [];
  dev.on('data', (d: Buffer) => dataCbs.forEach((cb) => cb(d)));
  dev.on('error', (e: Error) => errCbs.forEach((cb) => cb(e)));
  let closed = false;
  return {
    info,
    async write(data) {
      await dev.write(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
    },
    async sendFeatureReport(data) {
      await dev.sendFeatureReport(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
    },
    async getFeatureReport(reportId, length) {
      const b = await dev.getFeatureReport(reportId, length);
      return new Uint8Array(b);
    },
    onData(cb) {
      dataCbs.push(cb);
    },
    onError(cb) {
      errCbs.push(cb);
    },
    async close() {
      if (closed) return;
      closed = true;
      try {
        await dev.close();
      } catch {
        /* already gone */
      }
    },
  };
}
