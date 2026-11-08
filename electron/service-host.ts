// Supervises the service utility process: stable port and credentials, crash backoff, clean drain,
// and a WebSocket client that gives the menus and menu bar the same RPC surface as the editor.

import { utilityProcess, type UtilityProcess } from 'electron';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:net';
import { homedir, userInfo } from 'node:os';
import { randomBytes } from 'node:crypto';
import { WebSocket } from 'ws';
import type { AppState } from '../src/shared/types.ts';
import type { HostMessage, InferenceConfig, ServiceMessage, ServicePhase } from './protocol.ts';
import { log } from './log.ts';

export const HOST = '127.0.0.1';
const BACKOFF_MS = [500, 1000, 2000];
const CRASH_WINDOW_MS = 60_000;
const MAX_CRASHES = 3;
const STOP_TIMEOUT_MS = 3000;

export interface ServiceHostOptions {
  entry: string;
  dataDir: string;
  appName: string;
  sim: boolean;
  /** Port saved from an earlier launch; undefined picks a free one. */
  savedPort?: number;
  savePort(port: number): void;
  inference(): InferenceConfig;
}

export interface ServiceHostEvents {
  phase: [ServicePhase];
  appState: [AppState];
  frame: [string];
}

/** 43-character base64url credential, the shape session.ts expects. */
function credential(): string {
  return randomBytes(32).toString('base64url');
}

export function portFree(port: number): Promise<boolean> {
  return new Promise((done) => {
    const probe = createServer();
    probe.once('error', () => done(false));
    probe.listen(port, HOST, () => probe.close(() => done(true)));
  });
}

export async function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const probe = createServer();
    probe.once('error', fail);
    probe.listen(0, HOST, () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => done(port));
    });
  });
}

export class ServiceHost extends EventEmitter<ServiceHostEvents> {
  token = credential();
  browserToken = credential();
  port = 0;
  phase: ServicePhase = { phase: 'starting' };
  appState: AppState | null = null;
  private child: UtilityProcess | null = null;
  private expectedExit = new WeakSet<UtilityProcess>();
  private crashes: number[] = [];
  private restartTimer: NodeJS.Timeout | null = null;
  private stopping: Promise<void> | null = null;
  private ws: WebSocket | null = null;
  private wsTimer: NodeJS.Timeout | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void; timer: NodeJS.Timeout }>();
  private waiters = new Map<number, (m: ServiceMessage) => void>();
  private portRetried = false;
  private readonly opts: ServiceHostOptions;

  constructor(opts: ServiceHostOptions) {
    super();
    this.opts = opts;
  }

  get url(): string {
    return `http://${HOST}:${this.port}/#session=${this.browserToken}`;
  }

  get origin(): string {
    return `http://${HOST}:${this.port}`;
  }

  /** Chooses the stable port once per launch, then starts the service. */
  async start(): Promise<void> {
    const saved = this.opts.savedPort;
    this.port = saved && await portFree(saved) ? saved : await freePort();
    if (this.port !== saved) this.opts.savePort(this.port);
    this.spawn();
  }

  /** Manual restart from the fatal or error screens. */
  restart(): void {
    if (this.stopping) return;
    this.crashes = [];
    this.portRetried = false;
    this.killChild();
    this.spawn();
  }

  private setPhase(phase: ServicePhase) {
    this.phase = phase;
    this.emit('phase', phase);
  }

  private spawn() {
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null; }
    if (this.phase.phase !== 'restarting') this.setPhase({ phase: 'starting' });
    // An explicit allowlist: the service never sees the API key, terminal variables or NODE_OPTIONS.
    // USER and SHELL let the user's commands and the Claude Code / Codex CLIs find their Keychain
    // sign-in and login-shell PATH (read once by src/engine/user-env.ts).
    const user = (() => { try { return userInfo(); } catch { return null; } })();
    const env: Record<string, string> = {
      HOME: homedir(),
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      LANG: process.env.LANG || 'en_US.UTF-8',
      ...(user?.username ? { USER: user.username, LOGNAME: user.username } : {}),
      ...(user?.shell || process.env.SHELL ? { SHELL: (user?.shell || process.env.SHELL)! } : {}),
      ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
      // A socket path, not a secret: lets `git pull` over SSH use the keys loaded in your ssh-agent.
      ...(process.env.SSH_AUTH_SOCK ? { SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK } : {}),
    };
    const child = utilityProcess.fork(this.opts.entry, [], { serviceName: 'Open Smart Buttons Service', env, stdio: 'pipe' });
    this.child = child;
    child.stdout?.on('data', (d: Buffer) => log('service', String(d)));
    child.stderr?.on('data', (d: Buffer) => log('service', String(d)));
    child.on('message', (m: ServiceMessage) => this.onMessage(child, m));
    child.on('exit', (code) => this.onExit(child, code));
  }

  private post(message: HostMessage) {
    this.child?.postMessage(message);
  }

  private onMessage(child: UtilityProcess, m: ServiceMessage) {
    if (child !== this.child) return;
    switch (m.type) {
      case 'hello':
        this.post({
          type: 'start', dataDir: this.opts.dataDir, port: this.port, token: this.token, browserToken: this.browserToken,
          appName: this.opts.appName, sim: this.opts.sim, inference: this.opts.inference(),
        });
        break;
      case 'ready':
        log('main', `service ready on port ${m.port} (USB ${m.hidAvailable ? 'available' : 'unavailable'})`);
        this.portRetried = false; // a full start: a later crash may move ports once again
        this.setPhase({ phase: 'ready', url: this.url });
        this.connectSocket();
        break;
      case 'start-error':
        log('main', `service could not start: ${m.kind}: ${m.message}`);
        if (m.kind === 'port-in-use' && !this.portRetried) {
          // Something took the stable port while the service was down. Move once, with new credentials:
          // open windows may still be sending the old ones to whatever now listens on the old port.
          this.portRetried = true;
          this.killChild();
          void freePort().then((port) => {
            if (this.stopping) return;
            this.port = port;
            this.token = credential();
            this.browserToken = credential();
            this.opts.savePort(port);
            this.spawn();
          }, (error: Error) => this.setPhase({ phase: 'error', kind: 'start-failed', message: error.message }));
          return;
        }
        this.setPhase({ phase: 'error', kind: m.kind, message: m.message });
        break;
      default:
        if ('id' in m) this.waiters.get(m.id)?.(m);
        else for (const fn of this.waiters.values()) fn(m);
    }
  }

  /** Answers every outstanding request to a service that is gone. */
  private settleWaiters() {
    for (const fn of [...this.waiters.values()]) fn({ type: 'gone' } as unknown as ServiceMessage);
  }

  private onExit(child: UtilityProcess, code: number) {
    if (child === this.child) { this.child = null; this.settleWaiters(); }
    this.disconnectSocket();
    if (this.expectedExit.has(child) || this.stopping) return;
    if (this.phase.phase === 'error') return; // start-error already reported; nothing to restart
    log('main', `service exited unexpectedly (code ${code})`);
    const now = Date.now();
    this.crashes = [...this.crashes.filter((t) => now - t < CRASH_WINDOW_MS), now];
    if (this.crashes.length >= MAX_CRASHES) {
      this.setPhase({ phase: 'fatal', message: 'Open Smart Buttons stopped unexpectedly.' });
      return;
    }
    const attempt = this.crashes.length;
    this.setPhase({ phase: 'restarting', attempt });
    this.restartTimer = setTimeout(() => this.spawn(), BACKOFF_MS[attempt - 1] ?? 2000);
  }

  private killChild() {
    const child = this.child;
    if (!child) return;
    this.expectedExit.add(child);
    this.child = null;
    this.settleWaiters();
    child.kill();
  }

  /** Flushes the store and releases the deck and lock. Kills the service after 3 s. */
  stop(): Promise<void> {
    this.stopping ??= new Promise<void>((done) => {
      if (this.restartTimer) clearTimeout(this.restartTimer);
      this.setPhase({ phase: 'stopping' });
      this.disconnectSocket();
      const child = this.child;
      if (!child) { done(); return; }
      const timer = setTimeout(() => {
        log('main', 'service did not stop in time; killing it');
        child.kill();
      }, STOP_TIMEOUT_MS);
      child.once('exit', () => { clearTimeout(timer); done(); });
      child.postMessage({ type: 'stop' } satisfies HostMessage);
    });
    return this.stopping;
  }

  get isStopping(): boolean {
    return this.stopping !== null;
  }

  setInference(inference: InferenceConfig): void {
    this.post({ type: 'setInference', inference });
  }

  testInference(): Promise<{ ok: boolean; message: string }> {
    if (!this.child || this.phase.phase !== 'ready') return Promise.resolve({ ok: false, message: 'Open Smart Buttons is still starting.' });
    const id = this.nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.waiters.delete(id); resolve({ ok: false, message: 'The test timed out.' }); }, 100_000);
      this.waiters.set(id, (m) => {
        if ((m.type as string) === 'gone') {
          clearTimeout(timer);
          this.waiters.delete(id);
          resolve({ ok: false, message: 'Open Smart Buttons restarted during the test. Try again.' });
          return;
        }
        if (m.type !== 'inferenceTested') return;
        clearTimeout(timer);
        this.waiters.delete(id);
        resolve({ ok: m.ok, message: m.message });
      });
      this.post({ type: 'testInference', id });
    });
  }

  /**
   * Repairs an unreadable config: the idle service (which reported config-invalid) recovers a copy,
   * keeps the original aside and swaps the copy in. Then the service starts normally.
   */
  private repairing: Promise<{ ok: boolean; message: string }> | null = null;

  repair(): Promise<{ ok: boolean; message: string }> {
    if (this.repairing) return this.repairing;
    if (!this.child || this.phase.phase !== 'error' || this.phase.kind !== 'config-invalid') {
      return Promise.resolve({ ok: false, message: 'Nothing to repair.' });
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const id = this.nextId++;
    this.repairing = new Promise<{ ok: boolean; message: string }>((resolve) => {
      this.waiters.set(id, (m) => {
        if ((m.type as string) === 'gone') {
          this.waiters.delete(id);
          resolve({ ok: false, message: 'Open Smart Buttons stopped during the repair. Nothing was changed.' });
          return;
        }
        if (m.type !== 'repaired') return;
        this.waiters.delete(id);
        if (m.ok) {
          log('main', `repaired data: ${m.profiles} profiles, ${m.changes} changes; original kept at ${m.original}`);
          resolve({ ok: true, message: `Repaired ${m.profiles} profiles. The original is kept at ${m.original}.` });
          this.restart();
        } else {
          resolve({ ok: false, message: m.message });
        }
      });
      this.post({ type: 'repair', id, dataDir: this.opts.dataDir, stamp });
    }).finally(() => { this.repairing = null; });
    return this.repairing;
  }

  /** Resolves once the menu WebSocket is open (smoke checks call RPCs right after ready). */
  whenSocketOpen(timeoutMs: number): Promise<boolean> {
    const started = Date.now();
    return new Promise((done) => {
      const check = () => {
        if (this.ws?.readyState === WebSocket.OPEN) done(true);
        else if (Date.now() - started > timeoutMs) done(false);
        else setTimeout(check, 50);
      };
      check();
    });
  }

  // ---- WebSocket client (no Origin header, Bearer token: session.authorizedSocket) --------------

  private connectSocket() {
    this.disconnectSocket();
    const ws = new WebSocket(`ws://${HOST}:${this.port}/ws`, 'osb.v1', {
      headers: { authorization: `Bearer ${this.token}` },
      perMessageDeflate: false,
    });
    this.ws = ws;
    ws.on('message', (raw) => {
      let m: { id?: number; result?: unknown; error?: string; type?: string; state?: AppState; deviceId?: string };
      try { m = JSON.parse(String(raw)); } catch { return; }
      if (m.id !== undefined) {
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        clearTimeout(p.timer);
        if (m.error) p.reject(new Error(m.error)); else p.resolve(m.result);
      } else if (m.type === 'state' && m.state) {
        this.appState = m.state;
        this.emit('appState', m.state);
      } else if (m.type === 'frame' && typeof m.deviceId === 'string') {
        this.emit('frame', m.deviceId);
      }
    });
    ws.on('error', (error) => log('main', `menu client: ${error.message}`));
    ws.on('close', () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.failPending();
      if (this.phase.phase === 'ready' && !this.stopping) this.wsTimer = setTimeout(() => this.connectSocket(), 1000);
    });
  }

  private disconnectSocket() {
    if (this.wsTimer) { clearTimeout(this.wsTimer); this.wsTimer = null; }
    const ws = this.ws;
    this.ws = null;
    ws?.terminate();
    this.failPending();
  }

  private failPending() {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('Open Smart Buttons is restarting.')); }
    this.pending.clear();
  }

  rpc<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Open Smart Buttons is not ready yet.'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out`)); }, 15_000);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }
}
