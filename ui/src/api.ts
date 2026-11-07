// WebSocket client: RPC, live state, device frames, logs and HID traffic.

import { useSyncExternalStore } from 'react';
import type { AppState, HidLogEntry } from '../../src/shared/types.ts';

export interface DeviceFrames {
  keys: (string | null)[];
  infoBar?: string;
  lcd: { x: number; y: number; width: number; height: number; jpeg: string }[];
  rev: number;
}

export interface LogLine {
  t: number;
  level: 'info' | 'warn' | 'error';
  msg: string;
}

type Listener = () => void;

const launchToken = new URLSearchParams(location.hash.slice(1)).get('session');
const validLaunch = launchToken && /^[A-Za-z0-9_-]{43}$/.test(launchToken) ? launchToken : null;
let sessionToken = validLaunch;
try {
  if (validLaunch) sessionStorage.setItem('sdp-session', validLaunch);
  else sessionToken = sessionStorage.getItem('sdp-session');
} catch { /* The launch link still works with storage disabled. */ }
if (validLaunch) {
  history.replaceState(null, '', location.pathname + location.search);
}

export function privateImage(id: string, signal: AbortSignal) {
  return fetch(`/api/images/${encodeURIComponent(id)}`, {
    headers: { Authorization: `Bearer ${sessionToken ?? ''}` },
    signal,
  });
}

const RETRY_DELAYS = [250, 500, 1000];
const RETRY_CAP = 2000;

class Client {
  state: AppState | null = null;
  connected = false;
  /** True once any socket has opened, so a later drop reads as "reconnecting" rather than "never connected". */
  wasConnected = false;
  frames = new Map<string, DeviceFrames>();
  logs: LogLine[] = [];
  hid: HidLogEntry[] = [];
  pressed = new Map<string, Set<string>>();
  /** Knob angles (degrees) per device, driven by rotate events from real or simulated hardware. */
  angles = new Map<string, number[]>();
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private listeners = new Set<Listener>();
  private frameListeners = new Set<Listener>();
  private logListeners = new Set<Listener>();
  private hidOn = false;
  private retries = 0;
  version = 0;
  logVersion = 0;

  connect() {
    if (!sessionToken) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`, ['sdp.v1', `auth.${sessionToken}`]);
    this.ws = ws;
    ws.onopen = () => {
      this.connected = true;
      this.wasConnected = true;
      this.retries = 0;
      if (this.hidOn) void this.rpc('hid.subscribe', { on: true });
      this.notify();
    };
    ws.onclose = () => {
      this.connected = false;
      this.notify();
      for (const p of this.pending.values()) p.reject(new Error('Disconnected from StreamDeckPlus'));
      this.pending.clear();
      // The app restarts the service on the same port within a second or two, so retry quickly at first.
      const delay = RETRY_DELAYS[this.retries] ?? RETRY_CAP;
      this.retries++;
      setTimeout(() => this.connect(), delay);
    };
    ws.onmessage = (ev) => this.handle(JSON.parse(ev.data));
  }

  private handle(m: any) {
    if (m.id !== undefined && (m.result !== undefined || m.error !== undefined)) {
      const p = this.pending.get(m.id);
      this.pending.delete(m.id);
      if (m.error) p?.reject(new Error(m.error));
      else p?.resolve(m.result);
      return;
    }
    switch (m.type) {
      case 'state':
        this.state = m.state;
        for (const id of [...this.frames.keys()]) if (!m.state.devices.some((d: any) => d.id === id)) this.frames.delete(id);
        this.notify();
        break;
      case 'frame': {
        let f = this.frames.get(m.deviceId);
        if (!f) this.frames.set(m.deviceId, (f = { keys: [], lcd: [], rev: 0 }));
        if (m.target === 'infoBar') f.infoBar = m.jpeg;
        else if (m.target === 'key') f.keys[m.key] = m.jpeg;
        else {
          f.lcd = f.lcd.filter((r) => !(r.x >= m.x && r.y >= m.y && r.x + r.width <= m.x + m.width && r.y + r.height <= m.y + m.height));
          f.lcd.push({ x: m.x, y: m.y, width: m.width, height: m.height, jpeg: m.jpeg });
        }
        f.rev++;
        this.frameListeners.forEach((l) => l());
        break;
      }
      case 'log':
        this.logs = [...this.logs.slice(-299), { t: m.t, level: m.level, msg: m.msg }];
        if (m.level === 'error') toast(m.msg, 'error');
        this.logVersion++;
        this.logListeners.forEach((l) => l());
        break;
      case 'hid':
        this.hid = [...this.hid.slice(-499), m.entry];
        this.logVersion++;
        this.logListeners.forEach((l) => l());
        break;
      case 'input': {
        const { deviceId, ev } = m;
        if (ev.kind === 'rotate') {
          const a = this.angles.get(deviceId) ?? [0, 0, 0, 0];
          a[ev.index] = (a[ev.index] ?? 0) + ev.ticks * 15;
          this.angles.set(deviceId, [...a]);
        }
        let s = this.pressed.get(deviceId);
        if (!s) this.pressed.set(deviceId, (s = new Set()));
        const k = `${ev.kind}:${ev.index}`;
        if (ev.down === true) s.add(k);
        else if (ev.down === false) s.delete(k);
        else {
          s.add(k);
          setTimeout(() => {
            s!.delete(k);
            this.frameListeners.forEach((l) => l());
          }, 180);
        }
        this.frameListeners.forEach((l) => l());
        break;
      }
    }
  }

  rpc<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return reject(new Error('Not connected to StreamDeckPlus'));
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  setHid(on: boolean) {
    this.hidOn = on;
    if (this.connected) void this.rpc('hid.subscribe', { on });
  }

  private notify() {
    this.version++;
    this.listeners.forEach((l) => l());
  }
  subscribe = (l: Listener) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  subscribeFrames = (l: Listener) => {
    this.frameListeners.add(l);
    return () => this.frameListeners.delete(l);
  };
  subscribeLogs = (l: Listener) => {
    this.logListeners.add(l);
    return () => this.logListeners.delete(l);
  };
}

export const client = new Client();
client.connect();

export function useAppState() {
  useSyncExternalStore(client.subscribe, () => client.version);
  return { state: client.state, connected: client.connected, wasConnected: client.wasConnected };
}

let frameTick = 0;
client.subscribeFrames(() => frameTick++);
export function useFrames(deviceId: string | undefined) {
  useSyncExternalStore(client.subscribeFrames, () => frameTick);
  return deviceId ? client.frames.get(deviceId) : undefined;
}
export function usePressed(deviceId: string | undefined) {
  useSyncExternalStore(client.subscribeFrames, () => frameTick);
  return (deviceId && client.pressed.get(deviceId)) || new Set<string>();
}
export function useLogs() {
  useSyncExternalStore(client.subscribeLogs, () => client.logVersion);
  return { logs: client.logs, hid: client.hid };
}

// ---- toasts --------------------------------------------------------------------------------------
export type ToastAction = { label: string; run(): unknown };
type Toast = { id: number; msg: string; kind: 'info' | 'error'; action?: ToastAction };
let toasts: Toast[] = [];
let toastV = 0;
const toastListeners = new Set<Listener>();
function emitToasts() {
  toastV++;
  toastListeners.forEach((l) => l());
}
export function dismissToast(id: number) {
  toasts = toasts.filter((t) => t.id !== id);
  emitToasts();
}
export function toast(msg: string, kind: Toast['kind'] = 'info', action?: ToastAction) {
  const id = Date.now() + Math.random();
  toasts = [...toasts.slice(-3), { id, msg, kind, action }];
  emitToasts();
  setTimeout(() => dismissToast(id), kind === 'error' ? 5000 : action ? 6000 : 2600);
  return id;
}
/** Runs the newest toast's action (e.g. Undo). Returns false when there is none. */
export function runLatestToastAction(): boolean {
  const t = [...toasts].reverse().find((x) => x.action);
  if (!t) return false;
  dismissToast(t.id);
  void t.action!.run();
  return true;
}
export function useToasts() {
  useSyncExternalStore(
    (l) => {
      toastListeners.add(l);
      return () => toastListeners.delete(l);
    },
    () => toastV,
  );
  return toasts;
}

/** rpc that reports failures as a toast. */
export async function act<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T | undefined> {
  try {
    return await client.rpc<T>(method, params);
  } catch (e) {
    toast((e as Error).message, 'error');
    return undefined;
  }
}
