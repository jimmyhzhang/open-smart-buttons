// Actual HTTP/WebSocket server, isolated config, simulator only. Never touches port 4417 or USB.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { access, chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas } from '@napi-rs/canvas';
import { WebSocket } from 'ws';
import { actionChoices, matchesAction } from '../../src/shared/action-presets.ts';
import { Store } from '../../src/engine/store.ts';
import type { ActionInstance, AppState, Config, Profile } from '../../src/shared/types.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function bounded<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]);
  } finally { clearTimeout(timer); }
}

async function freePort(): Promise<number> {
  const lease = createServer();
  await new Promise<void>((resolve, reject) => { lease.once('error', reject); lease.listen(0, '127.0.0.1', () => resolve()); });
  const address = lease.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  await new Promise<void>((resolve, reject) => lease.close((error) => error ? reject(error) : resolve()));
  return port;
}

class AppServer {
  child: ChildProcessWithoutNullStreams;
  readonly endpoint: string;
  readonly tokenFile: string;
  private exited: Promise<void>;
  private output = '';
  private launchError: Error | undefined;
  constructor(port: number, data: string, extra: string[] = []) {
    this.endpoint = `http://127.0.0.1:${port}`;
    this.tokenFile = join(data, `session-${port}.token`);
    this.child = spawn(process.execPath, ['src/server/main.ts', '--no-hid', '--data', data, '--port', String(port), ...extra], {
      cwd: root, env: { ...process.env, STREAMDECKPLUS_DATA: data }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stdin.end();
    const capture = (chunk: Buffer) => { this.output = (this.output + String(chunk)).slice(-8000); };
    this.child.stdout.on('data', capture);
    this.child.stderr.on('data', capture);
    this.exited = new Promise((resolve) => {
      this.child.once('exit', () => resolve());
      this.child.once('error', (error) => { this.launchError = error; resolve(); });
    });
  }
  browserToken(): string {
    const token = this.output.match(/#session=([A-Za-z0-9_-]{43})/)?.[1];
    assert.ok(token, 'Server did not print a browser launch link.');
    return token;
  }
  async authorization(): Promise<string> {
    return `Bearer ${await readFile(this.tokenFile, 'utf8')}`;
  }
  async state(): Promise<AppState> {
    const response = await fetch(`${this.endpoint}/api/state`, { signal: AbortSignal.timeout(1500), headers: { authorization: await this.authorization() } });
    assert.equal(response.status, 200);
    return await response.json() as AppState;
  }
  async ready(): Promise<AppState> {
    for (const deadline = Date.now() + 10_000; Date.now() < deadline;) {
      if (this.launchError || this.child.exitCode !== null || this.child.signalCode !== null) {
        throw new Error(`Isolated server exited during startup: ${this.launchError?.message ?? this.output}`);
      }
      try { return await this.state(); } catch { await sleep(40); }
    }
    throw new Error(`Isolated server did not become ready: ${this.output}`);
  }
  async stop(): Promise<void> {
    if (this.launchError || this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.child.kill('SIGTERM');
    try { await bounded(this.exited, 2500, 'Graceful stop timed out'); } catch {
      this.child.kill('SIGKILL');
      await bounded(this.exited, 2500, 'Owned server did not exit after SIGKILL');
    }
  }
}

class RpcClient {
  readonly ws: WebSocket;
  readonly logs: string[] = [];
  readonly states: AppState[] = [];
  readonly inputs: { deviceId: string; ev: { kind: string; index: number; down?: boolean } }[] = [];
  private nextId = 0;
  private pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private constructor(endpoint: string, authorization: string) {
    this.ws = new WebSocket(endpoint.replace('http:', 'ws:') + '/ws', { handshakeTimeout: 3000, headers: { authorization } });
    this.ws.on('message', (raw) => {
      const message = JSON.parse(String(raw));
      if (typeof message.id === 'number') {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error));
        else pending.resolve(message.result);
      } else if (message.type === 'state') { this.states.push(message.state); if (this.states.length > 64) this.states.shift(); }
      else if (message.type === 'log') { this.logs.push(message.msg); if (this.logs.length > 256) this.logs.shift(); }
      else if (message.type === 'input') { this.inputs.push(message); if (this.inputs.length > 64) this.inputs.shift(); }
    });
    const disconnected = () => {
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('Isolated app connection closed')); }
      this.pending.clear();
    };
    this.ws.on('close', disconnected);
    this.ws.on('error', disconnected);
  }
  static async connect(endpoint: string, authorization: string): Promise<RpcClient> {
    const client = new RpcClient(endpoint, authorization);
    await bounded(new Promise<void>((resolve, reject) => { client.ws.once('open', resolve); client.ws.once('error', reject); }), 4000, 'WebSocket did not connect');
    return client;
  }
  call<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (this.ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Isolated app connection closed'));
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`RPC ${method} timed out`)); }, 4000);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async close(): Promise<void> {
    if (this.ws.readyState === WebSocket.CLOSED) return;
    const closed = new Promise<void>((resolve) => this.ws.once('close', () => resolve()));
    this.ws.close();
    try { await bounded(closed, 1000, 'WebSocket close timed out'); } catch { this.ws.terminate(); }
  }
}

async function eventually(check: () => boolean | Promise<boolean>, message: string): Promise<void> {
  for (const deadline = Date.now() + 5000; Date.now() < deadline;) { if (await check()) return; await sleep(20); }
  assert.fail(message);
}

function fixtureProfile(id: string, name: string): Profile {
  const counter = (instanceId: string): ActionInstance => ({ id: instanceId, type: 'util.counter', settings: {}, appearance: { title: 'Original', bg: '#123456' } });
  const keys: (ActionInstance | null)[] = [counter(`${id}-original`), null, null,
    { id: `${id}-folder-action`, type: 'sd.folder', settings: { folderId: `${id}-folder` }, appearance: { title: 'Preserved folder' } }, null, null, null, null];
  return { id, name, modelId: 'neo', createdAt: 1, pageOrder: [`${id}-main`, `${id}-second`], pages: {
    [`${id}-main`]: { id: `${id}-main`, name: 'Main', keys, dials: [], parentId: null },
    [`${id}-second`]: { id: `${id}-second`, name: 'Second', keys: Array(8).fill(null), dials: [], parentId: null },
    [`${id}-folder`]: { id: `${id}-folder`, name: 'Folder contents', keys: [counter(`${id}-child`), ...Array(7).fill(null)], dials: [], parentId: `${id}-main` },
  } };
}

test('action studio end to end: isolated HTTP/RPC setup, dry-run Neo routing, atomicity and restart persistence', { timeout: 60_000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'sdp-action-studio-e2e-'));
  const marker = join(dir, 'must-not-execute');
  const script = join(dir, 'selected script.sh');
  const schemaScript = join(dir, 'typed metadata.sh');
  const passwordScript = join(dir, 'interactive metadata.sh');
  const config: Config = { version: 2, profiles: [fixtureProfile('primary', 'Primary Neo'), fixtureProfile('other', 'Other Neo')], deviceProfiles: { 'sim:neo': 'primary' }, settings: {
    executeActions: false, autoSimulator: false, pressFeedback: false, defaultBrightness: 35, sleepDelay: 0, swipeChangesPages: true,
  } };
  await writeFile(join(dir, 'config.json'), JSON.stringify(config));
  await writeFile(script, '#!/bin/sh\n# @raycast.title Fixture Script\n# @raycast.mode compact\n# @raycast.argument1 {"type":"text","placeholder":"Marker"}\nprintf executed > "$1"\n');
  await chmod(script, 0o755);
  await writeFile(schemaScript, '#!/bin/sh\n# @raycast.title Typed Fixture\n# @raycast.argument1 {"type":"text","placeholder":"Query","percentEncoded":true}\n# @raycast.argument2 {"type":"dropdown","placeholder":"Mode","data":[{"title":"Preview","value":"preview"},{"title":"Review","value":"review"}]}\n# @raycast.argument3 {"type":"text","placeholder":"Marker","optional":true}\nprintf executed > "$3"\n');
  await chmod(schemaScript, 0o755);
  await writeFile(passwordScript, '#!/bin/sh\n# @raycast.title Interactive Fixture\n# @raycast.argument1 {"type":"password","placeholder":"Password","optional":true}\nprintf "%s" "$1"\n');
  await chmod(passwordScript, 0o755);
  let server: AppServer | undefined;
  let client: RpcClient | undefined;
  t.after(async () => { await client?.close(); await server?.stop(); await rm(dir, { recursive: true, force: true }); });
  server = new AppServer(await freePort(), dir);
  const initial = await server.ready();
  client = await RpcClient.connect(server.endpoint, await server.authorization());
  const rpc = client;
  const app = server;
  let deviceId = '';
  const base = { profileId: 'primary', pageId: 'primary-main', kind: 'key', index: 0, configured: true };
  const assign = (type: string, settings: Record<string, unknown>, patch: Record<string, unknown> = {}) => rpc.call<string>('slots.assign', { ...base, type, settings, ...patch });
  const press = async (key: number) => {
    const report = [1, 0, 10, 0, ...Array(10).fill(0)];
    report[4 + key] = 1;
    await rpc.call('devices.virtualInput', { deviceId, report });
    report[4 + key] = 0;
    await rpc.call('devices.virtualInput', { deviceId, report });
  };

  await t.test('state and upgrades reject absent credentials and foreign origins', async () => {
    const authorization = await app.authorization();
    const url = app.endpoint + '/api/state';
    assert.equal((await fetch(url)).status, 401);
    assert.equal((await fetch(url, { headers: { authorization, origin: 'http://127.0.0.1:59999' } })).status, 401);
    for (const headers of [{}, { authorization, origin: 'http://127.0.0.1:59999' }]) {
      const socket = new WebSocket(app.endpoint.replace('http:', 'ws:') + '/ws', { headers });
      await assert.rejects(new Promise<void>((resolve, reject) => {
        socket.once('open', resolve);
        socket.once('error', reject);
      }), /403/);
      socket.terminate();
    }
    const browser = new WebSocket(app.endpoint.replace('http:', 'ws:') + '/ws',
      ['sdp.v1', `auth.${app.browserToken()}`], { origin: app.endpoint });
    await bounded(new Promise<void>((resolve, reject) => {
      browser.once('message', raw => {
        try {
          assert.equal(JSON.parse(String(raw)).type, 'state');
          assert.equal(browser.protocol, 'sdp.v1');
          resolve();
        } catch (error) { reject(error); }
      });
      browser.once('error', reject);
    }), 2000, 'Browser-origin socket did not receive state');
    browser.terminate();
    const error = new Promise<Record<string, unknown>>((resolve) => rpc.ws.once('message', raw => resolve(JSON.parse(String(raw)))));
    rpc.ws.send('null');
    assert.equal((await error).error, 'Invalid RPC request');
    await assert.rejects(rpc.call('constructor'), /Unknown method/);
  });

  await t.test('HTTP catalog, presets and availability are usable before any device or execution', async () => {
    assert.equal(initial.config.settings.executeActions, false);
    assert.equal(initial.platform.canExecute, false);
    assert.equal(initial.platform.hidAvailable, false);
    assert.equal(initial.devices.length, 0);
    for (const type of ['agent.codex', 'agent.claude', 'system.script', 'system.shortcut', 'system.raycast', 'system.asyar']) assert.ok(initial.catalog.some((a) => a.type === type), type);
    const choices = actionChoices(initial.catalog);
    assert.ok(choices.some((choice) => choice.id === 'codex-review' && matchesAction(choice, 'codex review')));
    assert.ok(choices.some((choice) => choice.id === 'spotlight'));
    const status = await rpc.call<{ agents: { tool: string; name: string; installed: boolean }[] }>('integrations.status');
    assert.deepEqual(status.agents.map((a) => a.tool), ['codex', 'claude']);
    for (const agent of status.agents) { assert.equal(typeof agent.installed, 'boolean'); assert.deepEqual(Object.keys(agent).sort(), ['installed', 'name', 'tool']); }
    await assert.rejects(rpc.call('missing.test.method'), /Unknown method/);
    deviceId = await rpc.call<string>('sim.add', { modelId: 'neo' });
    const state = await app.state();
    const neo = state.devices.find((d) => d.id === deviceId)!;
    assert.equal(neo.modelId, 'neo'); assert.equal(neo.kind, 'sim'); assert.equal(neo.profileId, 'primary'); assert.equal(neo.pageId, 'primary-main');
  });

  await t.test('failed configuration preserves original slots and the complete folder graph', async () => {
    const before = (await app.state()).config;
    await assert.rejects(assign('agent.codex', { cwd: join(dir, 'missing'), mode: 'new' }), /working directory does not exist/);
    await assert.rejects(assign('agent.codex', { cwd: join(dir, 'missing'), mode: 'new' }, { index: 3, replaceFolder: true }), /working directory does not exist/);
    await assert.rejects(assign('system.raycast', { url: 'https://example.com' }, { index: 3, replaceFolder: true }), /valid Raycast.*deep link/);
    await assert.rejects(assign('system.open', { path: 'Fixture app' }, { index: 3 }), /Confirm replacing the folder/);
    assert.deepEqual((await app.state()).config, before);
  });

  await t.test('real RPC rejects invalid nested workflows before replacing a key or folder', async () => {
    const before = (await app.state()).config;
    let nextId = 0;
    const step = (type: string, settings: Record<string, unknown> = {}) => ({ id: `e2e-step-${++nextId}`, type, settings, appearance: {} });
    for (const steps of [
      [], [step('sd.delay', { ms: 50 })],
      [step('sd.multi', { steps: [step('system.text', { text: '' })] })],
      [step('sd.multi', { steps: [step('agent.codex', { cwd: join(dir, 'missing-nested-project'), mode: 'new' })] })],
      [step('sd.multi', { steps: [step('system.script', { path: script, arg1: '' })] })],
      [step('sd.multi', { steps: [step('missing.extension.command')] })],
    ]) {
      for (const index of [0, 3]) {
        await assert.rejects(assign('sd.multi', { steps }, { index, replaceFolder: true }));
        assert.deepEqual((await app.state()).config, before, 'all nested preflights must succeed before the original action graph can change');
      }
    }
    await assert.rejects(access(marker), { code: 'ENOENT' });
  });

  await t.test('configured save publishes the complete settings and appearance without executing', async () => {
    const stateStart = rpc.states.length;
    const logStart = rpc.logs.length;
    const settings = { cwd: dir, mode: 'continue', prompt: '' };
    const appearance = { title: 'Saved agent', icon: { kind: 'lucide', name: 'terminal' }, bg: '#314159' };
    const id = await assign('agent.codex', settings, { appearance });
    const expected = { id, type: 'agent.codex', settings, appearance };
    assert.deepEqual((await app.state()).config.profiles[0]!.pages['primary-main']!.keys[0], expected);
    await eventually(() => rpc.states.slice(stateStart).some((state) => state.config.profiles[0]!.pages['primary-main']!.keys[0]?.id === id), 'configured assignment state was not broadcast');
    for (const state of rpc.states.slice(stateStart)) {
      const action = state.config.profiles[0]!.pages['primary-main']!.keys[0];
      if (action?.id === id) assert.deepEqual(action, expected, 'subscribers never see half-configured actions');
    }
    assert.equal(rpc.logs.slice(logStart).some((line) => line.includes('[dry-run]')), false, 'saving an action must not execute it');
    await press(0);
    await eventually(() => rpc.logs.some((line) => line.includes('[dry-run] launch codex (continue)')), 'press should route to the dry-run agent implementation');
  });

  await t.test('metadata inspection and script pressing remain harmless in dry run', async () => {
    const metadata = await rpc.call<{ title: string; arguments: { placeholder: string }[] }>('scripts.inspect', { path: script });
    assert.equal(metadata.title, 'Fixture Script'); assert.equal(metadata.arguments[0]!.placeholder, 'Marker');
    await assign('system.script', { path: script, arg1: marker, arg2: '', arg3: '', showOutput: true }, { index: 1, appearance: { title: 'Fixture' } });
    await press(1);
    await eventually(() => rpc.logs.some((line) => line.includes('[dry-run] script ') && line.includes('selected script.sh')), 'Neo key should reach the dry-run script action');
    assert.ok(rpc.inputs.some(({ deviceId: id, ev }) => id === deviceId && ev.kind === 'key' && ev.index === 1 && ev.down === true));
    await assert.rejects(access(marker), { code: 'ENOENT' }, 'inspection, save and dry-run pressing must never execute the fixture');
  });

  await t.test('script metadata enforces required/dropdown inputs and stores percent-encoded fields as raw configuration', async () => {
    const metadata = await rpc.call<{ arguments: { index: number; percentEncoded: boolean; data?: { value: string }[] }[] }>('scripts.inspect', { path: schemaScript });
    assert.equal(metadata.arguments[0]!.percentEncoded, true);
    assert.deepEqual(metadata.arguments[1]!.data!.map((choice) => choice.value), ['preview', 'review']);
    const before = (await app.state()).config;
    await assert.rejects(assign('system.script', { path: schemaScript, arg1: '', arg2: 'preview' }, { index: 3, replaceFolder: true }), /Query.*required/);
    assert.deepEqual((await app.state()).config, before);
    await assert.rejects(assign('system.script', { path: schemaScript, arg1: 'raw query', arg2: 'not-declared' }, { index: 3, replaceFolder: true }), /Mode.*declared choices/);
    assert.deepEqual((await app.state()).config, before);
    const raw = 'space + %20 & unicode 雪';
    const id = await assign('system.script', { path: schemaScript, arg1: raw, arg2: 'review', arg3: marker, showOutput: true }, { index: 5, appearance: { title: 'Typed fixture' } });
    const saved = (await app.state()).config.profiles[0]!.pages['primary-main']!.keys[5]!;
    assert.equal(saved.id, id);
    assert.equal(saved.settings.arg1, raw, 'percent encoding is derived only for execution, never persisted or applied twice during save');
    assert.equal(saved.settings.arg2, 'review');
    const start = rpc.logs.length;
    await press(5);
    await eventually(() => rpc.logs.slice(start).some((line) => line.includes('[dry-run] script ') && line.includes('typed metadata.sh')), 'typed script should route through dry run');
    await assert.rejects(access(marker), { code: 'ENOENT' }, 'typed metadata must not turn inspection or dry run into native execution');
  });

  await t.test('password scripts remain inspectable but cannot save credential values into a button', async () => {
    const metadata = await rpc.call<{ arguments: { type: string }[]; warnings: string[] }>('scripts.inspect', { path: passwordScript });
    assert.equal(metadata.arguments[0]!.type, 'password');
    assert.match(metadata.warnings.join(' '), /Run it interactively/);
    const before = (await app.state()).config;
    const fixtureValue = 'not-a-real-credential-e2e';
    for (const index of [0, 3]) {
      await assert.rejects(assign('system.script', { path: passwordScript, arg1: fixtureValue }, { index, replaceFolder: true }), /saved buttons cannot store or supply password/);
      assert.deepEqual((await app.state()).config, before);
    }
    assert.equal(JSON.stringify((await app.state()).config).includes(fixtureValue), false);
    await assert.rejects(access(marker), { code: 'ENOENT' });
  });

  await t.test('folder clearing honors cancellation, stale action identity and explicit confirmation', async () => {
    const before = (await app.state()).config;
    const originalFolder = before.profiles[0]!.pages['primary-main']!.keys[3]!;
    await assert.rejects(rpc.call('slots.clear', { ...base, index: 3, expectedActionId: originalFolder.id, deleteFolder: false }), /Confirm deleting this folder/);
    await assert.rejects(rpc.call('slots.clear', { ...base, index: 3, expectedActionId: 'stale-action-id', deleteFolder: true }), /button changed/);
    assert.deepEqual((await app.state()).config, before);
    const folderActionId = await assign('sd.folder', {}, { index: 7, appearance: { title: 'Temporary E2E folder' } });
    const folderState = (await app.state()).config;
    const createdFolderId = String(folderState.profiles[0]!.pages['primary-main']!.keys[7]!.settings.folderId);
    assert.ok(folderState.profiles[0]!.pages[createdFolderId]);
    await rpc.call('slots.clear', { ...base, index: 7, expectedActionId: folderActionId, deleteFolder: true });
    let state = (await app.state()).config;
    assert.equal(state.profiles[0]!.pages['primary-main']!.keys[7], null);
    assert.equal(state.profiles[0]!.pages[createdFolderId], undefined);
    assert.ok(state.profiles[0]!.pages['primary-folder'], 'confirmed removal deletes only its own folder tree');
    const staleId = await assign('util.counter', {}, { index: 7 });
    const currentId = await assign('util.counter', {}, { index: 7, appearance: { title: 'Newer action' } });
    await assert.rejects(rpc.call('slots.clear', { ...base, index: 7, expectedActionId: staleId }), /button changed/);
    state = (await app.state()).config;
    assert.equal(state.profiles[0]!.pages['primary-main']!.keys[7]!.id, currentId);
    await rpc.call('slots.clear', { ...base, index: 7, expectedActionId: currentId });
  });

  await t.test('the physical key index follows the selected page and profile', async () => {
    for (const [profileId, pageId, text] of [['primary', 'primary-main', 'MAIN PAGE'], ['primary', 'primary-second', 'SECOND PAGE'], ['other', 'other-main', 'OTHER PROFILE']]) {
      await assign('system.text', { text, paste: false, enter: false }, { profileId, pageId, index: 2, appearance: { title: text } });
    }
    for (const [profileId, pageId, expected] of [['primary', 'primary-main', 'MAIN PAGE'], ['primary', 'primary-second', 'SECOND PAGE'], ['other', 'other-main', 'OTHER PROFILE']]) {
      await rpc.call('session.setProfile', { deviceId, profileId });
      await rpc.call('session.setPage', { deviceId, pageId });
      const start = rpc.logs.length;
      await press(2);
      await eventually(() => rpc.logs.slice(start).some((line) => line.includes(`[dry-run] type "${expected}"`)), `key 2 should route through ${profileId}/${pageId}`);
      const device = (await app.state()).devices.find((d) => d.id === deviceId)!;
      assert.equal(device.profileId, profileId); assert.equal(device.pageId, pageId);
    }
  });

  await t.test('rejects unsafe uploads, invalid profiles and settings before writing', async () => {
    const before = (await app.state()).config;
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>throw 1</script></svg>').toString('base64');
    await assert.rejects(rpc.call('images.upload', { ext: 'png', base64: svg }), /valid PNG or JPEG/);
    await assert.rejects(rpc.call('settings.update', { patch: { executeActions: 'false' } }), /Invalid setting/);
    const bad = structuredClone(before.profiles[0]!);
    bad.pageOrder.push(bad.pageOrder[0]!);
    await assert.rejects(rpc.call('profiles.importJson', { data: bad }), /Invalid profile model or page order/);
    assert.deepEqual((await app.state()).config, before);
  });

  await t.test('a saved raster asset is accessible only with a launch credential', async () => {
    const png = (await createCanvas(1, 1).encode('png')).toString('base64');
    const id = await rpc.call<string>('images.upload', { ext: 'png', base64: png });
    const url = `${app.endpoint}/api/images/${id}`;
    assert.equal((await fetch(url)).status, 401);
    const response = await fetch(url, { headers: { authorization: `Bearer ${app.browserToken()}` } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/png');
    assert.equal(Buffer.from(await response.arrayBuffer()).toString('base64'), png);
  });

  await t.test('a simulator stays in Dry run while hardware execution is enabled', async () => {
    await rpc.call('session.setProfile', { deviceId, profileId: 'primary' });
    await rpc.call('session.setPage', { deviceId, pageId: 'primary-main' });
    await assign('system.script', { path: script, arg1: marker }, { index: 1 });
    const unsafeChild = { id: 'child-script', type: 'system.script', settings: { path: script, arg1: marker }, appearance: {} };
    await assign('sd.multi', { steps: [unsafeChild] }, { index: 6 });
    await rpc.call('settings.update', { patch: { executeActions: true } });
    try {
      const live = await app.state();
      assert.equal(live.config.settings.executeActions, true);
      assert.equal(live.devices.find(d => d.id === deviceId)?.canExecute, false);
      for (const index of [1, 6]) {
        const start = rpc.logs.length;
        await rpc.call('slots.test', { deviceId, kind: 'key', index });
        await eventually(() => rpc.logs.slice(start).some(line => line.includes('[dry-run] script ')), 'Simulator action should only log execution');
        await press(index);
      }
      await assert.rejects(access(marker), { code: 'ENOENT' });
    } finally { await rpc.call('settings.update', { patch: { executeActions: false } }); }
  });

  await t.test('actual restart preserves configured actions, folder contents and the device profile binding', async () => {
    await rpc.call('session.setProfile', { deviceId, profileId: 'other' });
    const expected = (await app.state()).config;
    await rpc.close(); client = undefined;
    await app.stop(); server = undefined;
    assert.equal(app.child.exitCode, 0, 'owned server shuts down gracefully');
    assert.deepEqual(JSON.parse(await readFile(join(dir, 'config.json'), 'utf8')), expected);
    server = new AppServer(await freePort(), dir);
    const restarted = await server.ready();
    assert.deepEqual(restarted.config, expected);
    assert.equal(restarted.platform.canExecute, false);
    client = await RpcClient.connect(server.endpoint, await server.authorization());
    const restoredId = await client.call<string>('sim.add', { modelId: 'neo' });
    const restored = (await server.state()).devices.find((d) => d.id === restoredId)!;
    assert.equal(restored.profileId, 'other', 'sim:neo profile choice survives restart');
    assert.equal(restored.pageId, 'other-main', 'a restarted session begins on the saved profile first page');
    assert.equal(restarted.config.profiles[0]!.pages['primary-main']!.keys[0]!.appearance.title, 'Saved agent');
    assert.ok(restarted.config.profiles[0]!.pages['primary-folder'], 'rejected folder replacements never removed its contents');
    await assert.rejects(access(marker), { code: 'ENOENT' });
    const interrupted = assert.rejects(client.call('devices.identify', { deviceId: restoredId }), /connection closed/);
    await server.stop();
    await interrupted;
    await assert.rejects(client.call('integrations.status'), /connection closed/, 'stopped processes leave no hanging RPCs');
  });
});

test('simulator-only launch preserves the saved USB execution preference across shutdown', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'sdp-sim-preference-'));
  const store = new Store(dir);
  store.config.settings.executeActions = true;
  store.flush();
  const app = new AppServer(await freePort(), dir, ['--sim']);
  t.after(async () => { await app.stop(); await rm(dir, { recursive: true, force: true }); });
  const state = await app.ready();
  assert.equal(state.config.settings.executeActions, true);
  assert.equal(state.platform.canExecute, false);
  assert.equal(state.platform.hidAvailable, false);
  assert.equal(state.devices.length, 1);
  assert.equal(state.devices[0]!.canExecute, false);
  await app.stop();
  assert.equal(new Store(dir).config.settings.executeActions, true);
});
