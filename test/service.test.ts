// M1: the embeddable service. Loopback only, temporary data, no USB.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { WebSocket } from 'ws';
import { startService, ServiceStartError, acquireLock, releaseLockFile, type RunningService } from '../src/server/service.ts';
import { newCredential } from '../src/server/session.ts';
import { configureInference, inferenceAvailable } from '../src/engine/inference.ts';
import { setHostAppName } from '../src/engine/platform.ts';

const tempDir = (t: { after: (fn: () => void) => void }) => {
  const dir = mkdtempSync(join(tmpdir(), 'osb-service-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const base = { hid: false, autoSimulator: false } as const;

async function freePort(): Promise<number> {
  return new Promise((done) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => done(port));
    });
  });
}

async function get(svc: RunningService, path: string, token?: string) {
  return fetch(`${svc.origin}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
}

function rpc(svc: RunningService, method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  return new Promise((done, fail) => {
    const ws = new WebSocket(`ws://127.0.0.1:${svc.port}/ws`, 'osb.v1', { headers: { authorization: `Bearer ${svc.token}` } });
    ws.on('error', fail);
    ws.on('open', () => ws.send(JSON.stringify({ id: 1, method, params })));
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.id !== 1) return;
      ws.close();
      if (msg.error) fail(new Error(msg.error)); else done(msg.result);
    });
  });
}

test('port 0 serves a working editor and stop() releases every owned file', async (t) => {
  const dir = tempDir(t);
  const svc = await startService({ ...base, dataDir: dir, port: 0 });
  try {
    assert.ok(svc.port > 0);
    assert.match(svc.url, new RegExp(`^http://127\\.0\\.0\\.1:${svc.port}/#session=[A-Za-z0-9_-]{43}$`));
    const page = await get(svc, '/');
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy') ?? '', new RegExp(`connect-src 'self' ws://127\\.0\\.0\\.1:${svc.port};`));
    assert.equal((await get(svc, '/api/state')).status, 401);
    const state = await (await get(svc, '/api/state', svc.browserToken)).json();
    assert.equal(state.platform.hidAvailable, false);
    assert.equal(state.platform.hidError, undefined, 'USB deliberately off is not an error');
    assert.equal(readFileSync(join(dir, `session-${svc.port}.token`), 'utf8'), svc.token);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'server.json'), 'utf8')), { pid: process.pid, port: svc.port });
    assert.equal(await rpc(svc, 'devices.refresh'), null);
  } finally {
    assert.deepEqual(await svc.stop(), { saved: true });
  }
  for (const f of ['server.lock', 'server.json', `session-${svc.port}.token`]) assert.equal(existsSync(join(dir, f)), false, f);
  assert.ok(existsSync(join(dir, 'config.json')), 'config was flushed');
});

test('a restart with the supervisor\'s port and tokens keeps the same origin and credentials', async (t) => {
  const dir = tempDir(t);
  const token = newCredential();
  const browserToken = newCredential();
  const first = await startService({ ...base, dataDir: dir, port: 0, token, browserToken });
  const { port, url } = first;
  await first.stop();
  const second = await startService({ ...base, dataDir: dir, port, token, browserToken });
  try {
    assert.equal(second.url, url);
    assert.equal(second.token, token);
    assert.equal((await get(second, '/api/state', browserToken)).status, 200);
  } finally { assert.deepEqual(await second.stop(), { saved: true }); }
  await assert.rejects(startService({ ...base, dataDir: tempDir(t), port: 0, token: 'short' }), (e: unknown) =>
    e instanceof ServiceStartError && e.kind === 'start-failed');
});

test('two services refuse one data directory; the lock frees on stop', async (t) => {
  const dir = tempDir(t);
  const first = await startService({ ...base, dataDir: dir, port: 0 });
  try {
    await assert.rejects(startService({ ...base, dataDir: dir, port: 0 }), (e: unknown) =>
      e instanceof ServiceStartError && e.kind === 'locked');
  } finally { await first.stop(); }
  // A separate live process holding the lock is refused too.
  const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)']);
  t.after(() => holder.kill('SIGKILL'));
  await new Promise((done) => holder.once('spawn', done));
  writeFileSync(join(dir, 'server.lock'), String(holder.pid));
  await assert.rejects(startService({ ...base, dataDir: dir, port: 0 }), (e: unknown) =>
    e instanceof ServiceStartError && e.kind === 'locked' && e.message.includes(`pid ${holder.pid}`));
  holder.kill('SIGKILL');
  await new Promise((done) => holder.once('exit', done));
  const third = await startService({ ...base, dataDir: dir, port: 0 });
  await third.stop();
});

test('a lock left by a dead process is reclaimed atomically', (t) => {
  const dir = tempDir(t);
  const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  const lock = join(dir, 'server.lock');
  writeFileSync(lock, dead.stdout);
  assert.equal(acquireLock(lock), String(process.pid));
  assert.equal(readFileSync(lock, 'utf8'), String(process.pid));
  assert.throws(() => acquireLock(lock), (e: unknown) => e instanceof ServiceStartError && e.kind === 'locked', 'held in this process');
  releaseLockFile(lock, String(process.pid));
  assert.equal(existsSync(lock), false);
});

test('an unreadable config rejects as config-invalid, preserves the file and frees the lock', async (t) => {
  const dir = tempDir(t);
  writeFileSync(join(dir, 'config.json'), '{ not json');
  await assert.rejects(startService({ ...base, dataDir: dir, port: 0 }), (e: unknown) =>
    e instanceof ServiceStartError && e.kind === 'config-invalid' && /preserved/.test(e.message));
  assert.equal(readFileSync(join(dir, 'config.json'), 'utf8'), '{ not json');
  assert.equal(existsSync(join(dir, 'server.lock')), false);
});

test('a port in use rejects as port-in-use and frees the lock', async (t) => {
  const dir = tempDir(t);
  const blocker = createServer().listen(0, '127.0.0.1');
  await new Promise((done) => blocker.once('listening', done));
  t.after(() => blocker.close());
  const { port } = blocker.address() as { port: number };
  await assert.rejects(startService({ ...base, dataDir: dir, port }), (e: unknown) => e instanceof ServiceStartError && e.kind === 'port-in-use');
  assert.equal(existsSync(join(dir, 'server.lock')), false);
});

test('appName replaces the terminal name in permission copy', async (t) => {
  t.after(() => setHostAppName(null));
  const svc = await startService({ ...base, dataDir: tempDir(t), port: 0, appName: 'Open Smart Buttons' });
  try {
    const state = await (await get(svc, '/api/state', svc.token)).json();
    assert.equal(state.platform.host, 'Open Smart Buttons');
  } finally { assert.deepEqual(await svc.stop(), { saved: true }); }
});

test('configureInference turns AI design on and off without the environment', () => {
  configureInference({ apiKey: ' key ', model: 'model' });
  assert.equal(inferenceAvailable(), true);
  configureInference({ apiKey: 'key', model: '' });
  assert.equal(inferenceAvailable(), false);
  configureInference({});
  assert.equal(inferenceAvailable(), false);
});

test('the CLI restarts on the same data directory after SIGKILL with no manual recovery', async (t) => {
  const dir = tempDir(t);
  const port = await freePort();
  const launch = () => new Promise<ChildProcess>((done, fail) => {
    const child = spawn(process.execPath, ['src/server/main.ts', '--no-hid', '--port', String(port), '--data', dir], {
      env: { ...process.env, ANTHROPIC_API_KEY: '', OPEN_SMART_BUTTONS_CLAUDE_MODEL: '' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); fail(new Error(`no editor link: ${out}`)); }, 15000);
    child.stdout!.on('data', (d) => { out += d; if (out.includes('Open the editor at')) { clearTimeout(timer); done(child); } });
    child.stderr!.on('data', (d) => { out += d; });
    child.once('exit', (code) => { clearTimeout(timer); fail(new Error(`exited ${code}: ${out}`)); });
  });
  const first = await launch();
  const killed = new Promise((done) => first.once('exit', done));
  first.kill('SIGKILL');
  await killed;
  assert.ok(existsSync(join(dir, 'server.lock')), 'SIGKILL leaves a stale lock behind');
  const second = await launch();
  const exited = new Promise<number | null>((done) => second.once('exit', done));
  second.kill('SIGTERM');
  assert.equal(await exited, 0);
  assert.equal(existsSync(join(dir, 'server.lock')), false);
});

test('the CLI stops cleanly when SIGTERM arrives during startup', async (t) => {
  const dir = tempDir(t);
  const port = await freePort();
  const child = spawn(process.execPath, ['src/server/main.ts', '--no-hid', '--port', String(port), '--data', dir], { stdio: 'ignore' });
  const exited = new Promise<number | null>((done) => child.once('exit', (code) => done(code)));
  // Wait until the data directory is locked (startup in progress), then signal immediately.
  for (let i = 0; i < 200 && !existsSync(join(dir, 'server.lock')); i++) await new Promise((r) => setTimeout(r, 10));
  child.kill('SIGTERM');
  assert.equal(await exited, 0);
  for (const f of ['server.lock', 'server.json', `session-${port}.token`]) assert.equal(existsSync(join(dir, f)), false, f);
});
