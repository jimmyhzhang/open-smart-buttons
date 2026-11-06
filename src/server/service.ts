// StreamDeckPlus service: device manager + engine + HTTP/WebSocket API for the UI.
// Embeddable: the CLI (main.ts) and the desktop app's utility process both call startService().
// Nothing here calls process.exit or reads argv; startup failures reject with a ServiceStartError.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, existsSync, mkdirSync, statSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { join, extname, dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import { DeviceManager } from '../device/manager.ts';
import { Engine } from '../engine/engine.ts';
import { Store } from '../engine/store.ts';
import { CATALOG } from '../engine/actions.ts';
import { ButtonAgent } from '../engine/button-agent.ts';
import { createRpc, type RpcHandler } from './rpc.ts';
import { localSession, type LocalSession } from './session.ts';
import { aiStatus, resolveEngine, runAi } from '../engine/ai-engines.ts';
import { hostAppName, onKeepAwakeChange, setHostAppName, type PermissionCheck } from '../engine/platform.ts';
import { hexPreview, summarizeReport } from '../protocol/reports.ts';
import type { AppState, HidLogEntry } from '../shared/types.ts';
import type { StartErrorKind } from '../shared/native.ts';
import { warmUserPath } from '../engine/user-env.ts';

export const HOST = '127.0.0.1';

export interface ServiceOptions {
  dataDir: string;
  /** 0 picks a free port. The desktop app passes a stable port so origins and localStorage survive restarts. */
  port: number;
  /** Supplied by a supervisor that restarts the service; generated when omitted. */
  token?: string;
  browserToken?: string;
  sim?: boolean;
  hid?: boolean;
  /** Overrides the saved autoSimulator setting (the desktop app passes false). */
  autoSimulator?: boolean;
  /** Name macOS attributes permissions to, e.g. "StreamDeckPlus". Defaults to the terminal's name. */
  appName?: string;
  /** Also accept the Vite dev-server origin. Never set in packaged builds. */
  dev?: boolean;
  /**
   * Strict mode: only built-in deck, volume and Mac controls may run. Off by default so every
   * action in the library works; STREAMDECK_LOCAL_ONLY=1 turns it on from Terminal.
   */
  localOnly?: boolean;
}

export type ServiceStartErrorKind = StartErrorKind;

export class ServiceStartError extends Error {
  readonly kind: ServiceStartErrorKind;
  constructor(kind: ServiceStartErrorKind, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ServiceStartError';
    this.kind = kind;
  }
}

export interface RunningService {
  port: number;
  origin: string;
  token: string;
  browserToken: string;
  /** Editor URL including the browser credential fragment. */
  url: string;
  dataDir: string;
  hidAvailable: boolean;
  canExecute: boolean;
  stop(): Promise<{ saved: boolean }>;
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const uiDist = join(root, 'ui', 'dist');
const require = createRequire(import.meta.url);
const lucideRoot = dirname(require.resolve('lucide-static/package.json'));

function removeOwnedFile(file: string, contents: string): void {
  try { if (readFileSync(file, 'utf8') === contents) unlinkSync(file); } catch { /* file already removed */ }
}

function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

/**
 * Take the data directory lock. A lock left by a process that no longer exists (crash, SIGKILL) is
 * reclaimed with an atomic replace; a live owner is never displaced.
 */
const heldLocks = new Set<string>();

export function acquireLock(lockFile: string): string {
  const mine = String(process.pid);
  lockFile = resolve(lockFile);
  // Same pid, but a second service in this process: refuse rather than share the directory.
  if (heldLocks.has(lockFile)) throw new ServiceStartError('locked', `This data directory is already in use by this process: ${lockFile}.`);
  try {
    writeFileSync(lockFile, mine, { mode: 0o600, flag: 'wx' });
    heldLocks.add(lockFile);
    return mine;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const owner = Number(readFileSync(lockFile, 'utf8').trim());
  if (owner !== process.pid && processAlive(owner)) {
    throw new ServiceStartError('locked', `This data directory is in use by another StreamDeckPlus (pid ${owner}): ${lockFile}. Stop it before starting another.`);
  }
  const temp = `${lockFile}.${process.pid}.tmp`;
  writeFileSync(temp, mine, { mode: 0o600, flag: 'w' });
  renameSync(temp, lockFile);
  // Two reclaimers can race; the one whose pid survived the rename owns the lock.
  if (readFileSync(lockFile, 'utf8') !== mine) {
    throw new ServiceStartError('locked', `Another StreamDeckPlus took this data directory while starting: ${lockFile}.`);
  }
  heldLocks.add(lockFile);
  return mine;
}

export function releaseLockFile(lockFile: string, contents: string): void {
  lockFile = resolve(lockFile);
  removeOwnedFile(lockFile, contents);
  heldLocks.delete(lockFile);
}

export async function startService(opts: ServiceOptions): Promise<RunningService> {
  if (!Number.isInteger(opts.port) || opts.port < 0 || opts.port > 65535) {
    throw new ServiceStartError('start-failed', 'Choose a port from 0 to 65535.');
  }
  if (opts.appName) setHostAppName(opts.appName);
  const localOnly = opts.localOnly ?? process.env.STREAMDECK_LOCAL_ONLY === '1';
  void warmUserPath(); // read the login-shell PATH early, so the first command or AI design doesn't wait
  const dataDir = resolve(opts.dataDir);
  mkdirSync(dataDir, { mode: 0o700, recursive: true });
  const lockFile = join(dataDir, 'server.lock');
  const lockContents = acquireLock(lockFile);
  const releaseLock = () => releaseLockFile(lockFile, lockContents);

  let store: Store;
  try {
    store = new Store(dataDir, localOnly);
  } catch (error) {
    releaseLock();
    throw new ServiceStartError('config-invalid', (error as Error).message, { cause: error });
  }

  const manager = new DeviceManager();
  const engine = new Engine(store, manager, localOnly, !!opts.sim, true);
  let session: LocalSession | null = null;
  let boundPort = 0;
  let permissions: PermissionCheck[] = [];
  async function refreshPermissions(prompt = false, probeAutomation = false) {
    try {
      permissions = await engine.platform.checkPermissions(prompt, probeAutomation);
    } catch (e) {
      console.error('permission check failed', e);
    }
    engine.emit('state');
    return permissions;
  }
  const engineRpc = createRpc(engine);
  const buttonAgent = new ButtonAgent(engine, runAi);
  const rpc: Record<string, RpcHandler> = {
    ...engineRpc,
    'buttonAgent.list': () => buttonAgent.list(),
    'buttonAgent.clearHistory': () => buttonAgent.clearHistory(),
    // Which AI designs buttons, and whether each engine is installed and signed in.
    'buttonAgent.availability': ({ refresh } = {}) => aiStatus(refresh === true),
    'buttonAgent.start': async ({ target, instruction, provider, expectedActionId }) => {
      const engineId = await resolveEngine(provider);
      return buttonAgent.start(target, instruction, engineId, expectedActionId);
    },
    'buttonAgent.cancel': ({ id }) => buttonAgent.cancel(id),
    'buttonAgent.test': ({ id, deviceId }) => buttonAgent.test(id, deviceId),
    'buttonAgent.undo': ({ id }) => buttonAgent.undo(id),
    'settings.update': async (params) => {
      await engineRpc['settings.update']!(params);
      if (params.patch?.executeActions !== undefined) await refreshPermissions(false, false);
    },
    'platform.permissions': ({ prompt }: Record<string, any>) => refreshPermissions(!!prompt, !!prompt),
    'platform.openSettings': async ({ id }: Record<string, any>) => engine.platform.openPermissionSettings(id === 'automation' ? 'automation' : 'accessibility'),
  };
  engine.on('permission', () => void refreshPermissions(false, false));

  // ---- frame cache so new UI clients see the current device surfaces immediately ----------------
  const frames = new Map<string, { keys: (string | null)[]; infoBar?: string; lcd: Map<string, { x: number; y: number; width: number; height: number; jpeg: string }> }>();
  engine.on('frame', (deviceId, f) => {
    let c = frames.get(deviceId);
    if (!c) frames.set(deviceId, (c = { keys: [], lcd: new Map() }));
    const jpeg = Buffer.from(f.jpeg).toString('base64');
    if (f.target === 'infoBar') {
      c.infoBar = jpeg;
      broadcast({ type: 'frame', deviceId, target: 'infoBar', jpeg });
      return;
    }
    if (f.target === 'key') c.keys[f.key] = jpeg;
    else c.lcd.set(`${f.x},${f.y},${f.width},${f.height}`, { x: f.x, y: f.y, width: f.width, height: f.height, jpeg });
    broadcast({ type: 'frame', deviceId, ...(f.target === 'key' ? { target: 'key', key: f.key } : { target: 'lcd', x: f.x, y: f.y, width: f.width, height: f.height }), jpeg });
  });
  manager.on('detach', (d) => frames.delete(d.id));

  // ---- protocol inspector (rate-limited) -----------------------------------------------------------
  let hidBudget = 0;
  const hidBudgetTimer = setInterval(() => (hidBudget = 0), 1000);
  hidBudgetTimer.unref();
  engine.on('report', (deviceId, dir, bytes) => {
    if (!hidSubscribers.size || ++hidBudget > 400) return;
    const dev = manager.devices.get(deviceId);
    const e: HidLogEntry = {
      t: Date.now(),
      deviceId,
      dir,
      summary: summarizeReport(dir, bytes, dev ? dev.model.columns * dev.model.rows + (dev.model.touchPoints ?? 0) : 8, dev?.model.encoders ?? 4),
      hex: hexPreview(bytes, dir === 'in' ? 14 : 16),
    };
    for (const ws of hidSubscribers) send(ws, { type: 'hid', entry: e });
  });
  engine.on('log', (level, msg) => broadcast({ type: 'log', level, msg, t: Date.now() }));
  engine.on('input', (deviceId, ev) => broadcast({ type: 'input', deviceId, ev }));

  function appState(): AppState {
    return {
      config: store.config,
      catalog: CATALOG,
      devices: engine.summaries(),
      discovered: manager.list().map((d) => ({
        path: d.info.path,
        kind: d.info.kind,
        productId: d.info.productId,
        modelName: d.modelName,
        supported: d.supported,
        deviceId: d.deviceId,
        error: d.error,
        serial: d.info.serialNumber,
      })),
      platform: { os: engine.platform.os, hidAvailable: manager.hidAvailable, hidError: manager.hidError, canExecute: engine.platform.canExecute, localOnly: engine.localOnly, host: hostAppName(), permissions },
    };
  }

  let stateTimer: ReturnType<typeof setTimeout> | null = null;
  engine.on('state', () => {
    if (stateTimer) return;
    stateTimer = setTimeout(() => {
      stateTimer = null;
      broadcast({ type: 'state', state: appState() });
    }, 30);
  });

  // ---- WebSocket ----------------------------------------------------------------------------------
  const clients = new Set<WebSocket>();
  const hidSubscribers = new Set<WebSocket>();
  function send(ws: WebSocket, msg: unknown) {
    sendSerialized(ws, JSON.stringify(msg));
  }
  function sendSerialized(ws: WebSocket, message: string) {
    if (ws.readyState !== ws.OPEN) return;
    if (ws.bufferedAmount > 8 * 1024 * 1024) { ws.terminate(); return; }
    ws.send(message);
  }
  function broadcast(msg: unknown) {
    const s = JSON.stringify(msg);
    for (const ws of clients) sendSerialized(ws, s);
  }

  const http = createServer((req, res) => void handleHttp(req, res));
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 18 * 1024 * 1024,
    handleProtocols: (protocols) => protocols.has('sdp.v1') ? 'sdp.v1' : false,
  });
  http.on('upgrade', (req, socket, head) => {
    const allowed = !!session && session.validHost(req) && req.url === '/ws' && session.authorizedSocket(req);
    if (!allowed) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    if (clients.size >= 12) {
      socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws));
  });
  wss.on('connection', (ws) => {
    clients.add(ws);
    let inFlight = 0;
    ws.on('error', () => ws.terminate());
    send(ws, { type: 'state', state: appState() });
    for (const [deviceId, c] of frames) {
      c.keys.forEach((jpeg, key) => jpeg && send(ws, { type: 'frame', deviceId, target: 'key', key, jpeg }));
      for (const l of c.lcd.values()) send(ws, { type: 'frame', deviceId, target: 'lcd', ...l });
      if (c.infoBar) send(ws, { type: 'frame', deviceId, target: 'infoBar', jpeg: c.infoBar });
    }
    ws.on('message', async (raw) => {
      let value: unknown;
      try {
        value = JSON.parse(String(raw));
      } catch {
        send(ws, { id: null, error: 'Invalid JSON' });
        return;
      }
      const msg = value as { id?: number; method?: string; params?: Record<string, unknown> } | null;
      if (!msg || typeof msg !== 'object' || Array.isArray(msg) || !Number.isSafeInteger(msg.id) ||
        typeof msg.method !== 'string' || msg.method.length > 80 ||
        (msg.params !== undefined && (!msg.params || typeof msg.params !== 'object' || Array.isArray(msg.params)))) {
        send(ws, { id: Number.isSafeInteger(msg?.id) ? msg!.id : null, error: 'Invalid RPC request' });
        return;
      }
      if (msg.method === 'hid.subscribe') {
        if (msg.params?.on) hidSubscribers.add(ws);
        else hidSubscribers.delete(ws);
        send(ws, { id: msg.id, result: true });
        return;
      }
      const fn = Object.hasOwn(rpc, msg.method) ? rpc[msg.method] : undefined;
      if (!fn) {
        send(ws, { id: msg.id, error: `Unknown method ${msg.method}` });
        return;
      }
      if (inFlight >= 16) {
        send(ws, { id: msg.id, error: 'Too many pending requests. Try again.' });
        return;
      }
      inFlight++;
      try {
        const result = await fn(msg.params ?? {});
        send(ws, { id: msg.id, result: result ?? null });
      } catch (e) {
        send(ws, { id: msg.id, error: (e as Error).message });
      } finally { inFlight--; }
    });
    ws.on('close', () => {
      clients.delete(ws);
      hidSubscribers.delete(ws);
    });
  });

  // ---- HTTP ---------------------------------------------------------------------------------------
  const MIME: Record<string, string> = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
    '.json': 'application/json', '.woff2': 'font/woff2', '.ico': 'image/x-icon',
  };

  let lucideIndex: string | null = null;
  function lucideIndexJson(): string {
    if (lucideIndex) return lucideIndex;
    let tags: Record<string, string[]> = {};
    try {
      tags = JSON.parse(readFileSync(join(lucideRoot, 'tags.json'), 'utf8'));
    } catch {
      /* optional */
    }
    lucideIndex = JSON.stringify(tags);
    return lucideIndex;
  }

  function sendFile(res: ServerResponse, path: string, cache = 'no-cache') {
    res.writeHead(200, { 'content-type': MIME[extname(path).toLowerCase()] ?? 'application/octet-stream', 'cache-control': cache });
    res.end(readFileSync(path));
  }

  async function handleHttp(req: IncomingMessage, res: ServerResponse) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ws://${HOST}:${boundPort}; font-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`);
    if (!session) return void res.writeHead(503).end();
    if (!session.validHost(req)) return void res.writeHead(403).end();
    let p: string;
    try { p = decodeURIComponent(new URL(req.url ?? '/', session.origin).pathname); }
    catch { return void res.writeHead(400).end(); }
    if (req.method !== 'GET' && req.method !== 'HEAD') return void res.writeHead(405).end();
    try {
      if ((p === '/api/state' || p.startsWith('/api/images/')) && !session.authorizedHttp(req)) {
        return void res.writeHead(401, { 'Cache-Control': 'no-store' }).end();
      }
      if (p.startsWith('/api/images/')) {
        const f = store.imagePath(p.slice('/api/images/'.length));
        if (!f) return void res.writeHead(404).end();
        return sendFile(res, f, 'private, no-store');
      }
      if (p === '/api/lucide/index.json') {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'max-age=86400' });
        return void res.end(lucideIndexJson());
      }
      if (p.startsWith('/api/lucide/')) {
        const name = p.slice('/api/lucide/'.length).replace(/\.svg$/, '');
        if (!/^[a-z0-9-]+$/.test(name)) return void res.writeHead(404).end();
        const f = join(lucideRoot, 'icons', `${name}.svg`);
        if (!existsSync(f)) return void res.writeHead(404).end();
        return sendFile(res, f, 'max-age=86400');
      }
      if (p === '/api/state') {
        res.writeHead(200, { 'content-type': 'application/json', 'Cache-Control': 'no-store' });
        return void res.end(JSON.stringify(appState()));
      }
      if (p.startsWith('/api/')) return void res.writeHead(404).end();
      // Static UI
      if (!existsSync(uiDist)) {
        res.writeHead(200, { 'content-type': 'text/html' });
        return void res.end('<p>UI not built. Run <code>npm run build:ui</code> (or <code>npm start</code>).</p>');
      }
      let f = join(uiDist, p);
      if (!f.startsWith(uiDist + sep) || !existsSync(f) || statSync(f).isDirectory()) f = join(uiDist, 'index.html');
      return sendFile(res, f, f.endsWith('index.html') ? 'no-cache' : 'max-age=31536000, immutable');
    } catch (e) {
      res.writeHead(500).end((e as Error).message);
    }
  }

  // ---- boot ---------------------------------------------------------------------------------------
  let sessionFile = '';
  let awakeFile = '';
  let serverFile = '';
  let serverJson = '';
  let stopping: Promise<{ saved: boolean }> | null = null;
  async function stop(): Promise<{ saved: boolean }> {
    stopping ??= (async () => {
      if (awakeFile) {
        // A clean stop (quit, logout) does not carry Keep Awake into the next launch.
        onKeepAwakeChange(null);
        try { unlinkSync(awakeFile); } catch { /* not set */ }
      }
      if (session) removeOwnedFile(sessionFile, session.token);
      if (serverJson) removeOwnedFile(serverFile, serverJson);
      let saved = true;
      try {
        buttonAgent.close();
        store.flush();
      } catch (error) {
        console.error('Could not save the current session:', (error as Error).message);
        saved = false;
      }
      clearInterval(hidBudgetTimer);
      if (stateTimer) clearTimeout(stateTimer);
      for (const ws of clients) ws.terminate();
      try { await manager.stop(); }
      finally {
        await new Promise<void>((done) => { wss.close(() => done()); });
        http.closeAllConnections?.();
        await new Promise<void>((done) => { http.close(() => done()); });
        releaseLock();
      }
      return { saved };
    })();
    return stopping;
  }

  try {
    await manager.start({ hid: opts.hid !== false && !opts.sim });
    await refreshPermissions(false, false);
    const autoSimulator = opts.autoSimulator ?? store.config.settings.autoSimulator;
    if (opts.sim || (autoSimulator && manager.devices.size === 0)) await manager.addSimulator('plus', { serial: 'SIMPLUS0001' });
    await new Promise<void>((done, fail) => {
      const onError = (error: NodeJS.ErrnoException) => {
        fail(new ServiceStartError(error.code === 'EADDRINUSE' ? 'port-in-use' : 'start-failed',
          `Could not start the local editor: ${error.message}`, { cause: error }));
      };
      http.once('error', onError);
      http.listen(opts.port, HOST, () => {
        http.off('error', onError);
        http.on('error', (error) => console.error('local editor error:', error.message));
        done();
      });
    });
    // Keep Awake follows the service process (caffeinate -w <pid>). A marker survives only a crash or
    // SIGKILL (a clean stop removes it), so a supervised restart turns it back on.
    awakeFile = join(store.dir, 'keep-awake');
    const restoreAwake = existsSync(awakeFile);
    onKeepAwakeChange((on) => {
      try { if (on) writeFileSync(awakeFile, '', { mode: 0o600 }); else unlinkSync(awakeFile); } catch { /* best effort */ }
    });
    if (restoreAwake) {
      if (engine.platform.canExecute) await engine.platform.keepAwake(true).catch(() => false);
      else try { unlinkSync(awakeFile); } catch { /* already gone */ }
    }
    boundPort = (http.address() as AddressInfo).port;
    session = localSession({ port: boundPort, dev: !!opts.dev, token: opts.token, browserToken: opts.browserToken });
    sessionFile = join(store.dir, `session-${boundPort}.token`);
    const temp = `${sessionFile}.${process.pid}.tmp`;
    writeFileSync(temp, session.token, { mode: 0o600, flag: 'w' });
    renameSync(temp, sessionFile);
    serverFile = join(store.dir, 'server.json');
    serverJson = JSON.stringify({ pid: process.pid, port: boundPort });
    writeFileSync(`${serverFile}.${process.pid}.tmp`, serverJson, { mode: 0o600, flag: 'w' });
    renameSync(`${serverFile}.${process.pid}.tmp`, serverFile);
  } catch (error) {
    await stop().catch(() => {});
    throw error instanceof ServiceStartError ? error : new ServiceStartError('start-failed', (error as Error).message, { cause: error });
  }

  const s = session;
  return {
    port: boundPort,
    origin: s.origin,
    token: s.token,
    browserToken: s.browserToken,
    url: `${s.origin}/#session=${s.browserToken}`,
    dataDir: store.dir,
    hidAvailable: manager.hidAvailable,
    canExecute: engine.platform.canExecute,
    stop,
  };
}
