// Read-only diagnosis of an already running Open Smart Buttons server.
// No device access or action/permission RPCs: only GET /api/state and hid.subscribe.
import { WebSocket } from 'ws';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { appDataDir } from '../engine/app-compat.ts';
import type { ActionInstance, AppState, DeviceSummary, HidLogEntry } from '../shared/types.ts';

const args = process.argv.slice(2);
const usage = 'Usage: npm run doctor -- [--port 4417] [--listen]\n\nReads the running app and lists the current key mappings.\n--listen  Observe input and incoming HID reports for 30 seconds.\n--port N  Use another local app port (default: the running app port, else 4417).\nNo actions, configuration changes, USB access, or permission prompts.';
let port: number | null = null;
let data = appDataDir();
let listen = false;
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--help' || arg === '-h') {
    console.log(usage);
    process.exit(0);
  }
  if (arg === '--listen') listen = true;
  else if (arg === '--data' && args[i + 1]) data = args[++i]!;
  else if (arg === '--port') {
    const value = args[++i];
    if (!value || !/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) {
      console.error('doctor: --port requires a number from 1 to 65535.');
      process.exit(1);
    }
    port = Number(value);
  } else {
    console.error(`doctor: unknown option ${JSON.stringify(arg)}. Use --help.`);
    process.exit(1);
  }
}

// Labels are the only profile/action content printed. Never stringify app state or settings.
const label = (value: unknown): string => String(value ?? '').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, 160);
// Without --port, find the running app's port from its server.json (the desktop app may not use 4417).
if (port === null) {
  try {
    const info = JSON.parse(readFileSync(join(data, 'server.json'), 'utf8')) as { port?: unknown };
    port = Number.isInteger(info.port) && (info.port as number) > 0 && (info.port as number) <= 65535 ? info.port as number : 4417;
  } catch { port = 4417; }
}
const endpoint = `http://127.0.0.1:${port}`;
let authorization: string;
const aliases = new Map<string, number>();
const deviceLabel = (d: DeviceSummary): string => {
  if (!aliases.has(d.id)) aliases.set(d.id, aliases.size + 1);
  return `device ${aliases.get(d.id)} (${label(d.modelName)}, ${d.kind})`;
};
const location = (d: DeviceSummary, key: number): string => `key ${key} (row ${Math.floor(key / d.columns) + 1}, column ${key % d.columns + 1})`;
function actionLabel(state: AppState, action: ActionInstance | null | undefined): string {
  if (!action) return 'unassigned';
  const name = state.catalog.find((a) => a.type === action.type)?.name ?? 'Unknown action';
  return `${label(action.type)} / ${label(name)}${action.appearance?.title ? ` / title ${JSON.stringify(label(action.appearance.title))}` : ''}`;
}

function report(state: AppState): void {
  const execution = state.config.settings.executeActions && state.platform.canExecute ? 'LIVE' : 'DRY RUN';
  console.log(`Open Smart Buttons ${endpoint} — ${execution}`);
  console.log(`Host: ${label(state.platform.host)}; OS: ${label(state.platform.os)}; HID: ${state.platform.hidAvailable ? 'available' : 'unavailable'}`);
  if (!state.platform.permissions.length) console.log('Permissions: no status reported by the app.');
  for (const p of state.platform.permissions) {
    console.log(`Permission ${label(p.label)}: ${p.ok === true ? 'allowed' : p.ok === false ? 'blocked' : 'unknown / not checked'}`);
  }
  if (!state.devices.length) console.log('No connected devices or simulators.');
  for (const d of state.devices) {
    const profile = state.config.profiles.find((p) => p.id === d.profileId);
    const page = profile?.pages[d.pageId];
    console.log(`\n${deviceLabel(d)} — profile ${JSON.stringify(label(profile?.name ?? '(missing)'))}, page ${JSON.stringify(label(page?.name ?? '(missing)'))}`);
    for (let key = 0; key < d.columns * d.rows; key++) {
      console.log(`  ${location(d, key)} → ${actionLabel(state, page?.keys[key])}`);
    }
    if (d.touchPoints) console.log('  Touch point 0 → previous page; touch point 1 → next page');
  }
  console.log('\nKey indices are 0-based; physical rows and columns are 1-based from the top left.');
}

async function readState(): Promise<AppState> {
  let response: Response;
  try {
    response = await fetch(`${endpoint}/api/state`, { headers: { authorization }, redirect: 'error', signal: AbortSignal.timeout(4000) });
  } catch {
    throw new Error(`cannot reach ${endpoint}. Start the app first, or select its --port.`);
  }
  if (!response.ok) throw new Error(`app returned HTTP ${response.status} for /api/state.`);
  const state = await response.json() as AppState;
  if (!Array.isArray(state.devices) || !Array.isArray(state.config?.profiles) || !Array.isArray(state.catalog) || !Array.isArray(state.platform?.permissions)) {
    throw new Error('the server did not return a compatible app state.');
  }
  return state;
}

async function observe(initial: AppState): Promise<void> {
  console.log('\nListening for 30 seconds. Press the physical keys to see input and their current action labels.');
  let state = initial;
  let inputs = 0;
  let hidReports = 0;
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { authorization }, handshakeTimeout: 4000 });
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      process.off('SIGINT', stop);
      ws.terminate();
      if (error) reject(error);
      else resolve();
    };
    const stop = () => finish();
    process.once('SIGINT', stop);
    ws.on('open', () => {
      // This only subscribes this connection to existing incoming HID observations.
      ws.send(JSON.stringify({ id: 1, method: 'hid.subscribe', params: { on: true } }));
      timer = setTimeout(() => finish(), 30_000);
    });
    ws.on('message', (raw) => {
      let msg: { type?: string; state?: AppState; deviceId?: string; ev?: { kind: string; index: number; down?: boolean }; entry?: HidLogEntry };
      try { msg = JSON.parse(String(raw)); } catch { return; }
      if (msg.type === 'state' && msg.state) {
        state = msg.state;
      } else if (msg.type === 'input' && msg.ev) {
        const d = state.devices.find((device) => device.id === msg.deviceId);
        if (!d) return;
        const ev = msg.ev;
        if (ev.kind === 'key') {
          inputs++;
          const profile = state.config.profiles.find((p) => p.id === d.profileId);
          const action = profile?.pages[d.pageId]?.keys[ev.index];
          console.log(`${deviceLabel(d)} key${ev.down ? 'Down' : 'Up'} ${location(d, ev.index)}${ev.down ? ` → ${actionLabel(state, action)}` : ''}`);
        } else if (ev.kind === 'touchpoint') {
          inputs++;
          console.log(`${deviceLabel(d)} touchPoint${ev.down ? 'Down' : 'Up'} ${ev.index}${ev.down ? ` → ${ev.index === 0 ? 'previous' : 'next'} page` : ''}`);
        }
      } else if (msg.type === 'hid' && msg.entry?.dir === 'in') {
        const d = state.devices.find((device) => device.id === msg.entry?.deviceId);
        if (!d) return;
        hidReports++;
        console.log(`${deviceLabel(d)} HID in: ${label(msg.entry.summary)} [${label(msg.entry.hex)}]`);
      }
    });
    ws.on('error', () => finish(new Error(`could not observe the app WebSocket at ${endpoint}.`)));
    ws.on('close', () => finish(new Error('the app disconnected during observation.')));
  });
  console.log(`Observation finished: ${inputs} key/touch-point events, ${hidReports} incoming HID reports.`);
  if (!inputs && !hidReports) console.log('No input observed. Check the selected device and press its physical keys while listening.');
}

try {
  try { authorization = `Bearer ${readFileSync(join(data, `session-${port}.token`), 'utf8')}`; }
  catch { throw new Error('Start the app first, or use its --port and --data values.'); }
  const state = await readState();
  report(state);
  if (listen) await observe(state);
} catch (e) {
  console.error(`doctor: ${(e as Error).message}`);
  process.exitCode = 1;
}
