// Utility process entry: runs the StreamDeckPlus service for the desktop app.
// The main process talks to it only over parentPort. Credentials and the API key arrive in messages,
// never in argv or the environment, so `ps eww` shows neither.

import { renameSync, existsSync } from 'node:fs';
import { configureInference, testInference } from '../src/engine/inference.ts';
import { recoverDataDir } from '../src/engine/data-recovery.ts';
import { startService, ServiceStartError, type RunningService } from '../src/server/service.ts';
import type { HostMessage, ServiceMessage, StartRequest } from './protocol.ts';

// utilityProcess provides process.parentPort; its type is not in @types/node.
const port = (process as unknown as { parentPort: { on(e: 'message', fn: (ev: { data: HostMessage }) => void): void; postMessage(m: ServiceMessage): void } }).parentPort;
const send = (message: ServiceMessage) => port.postMessage(message);

let service: RunningService | null = null;
let starting: Promise<RunningService> | null = null;
let stopping = false;

process.on('uncaughtException', (error) => {
  console.error('service crashed:', error);
  process.exit(70);
});
process.on('unhandledRejection', (error) => console.error('unhandled:', error));

async function start(request: StartRequest) {
  configureInference(request.inference);
  try {
    starting = startService({
      dataDir: request.dataDir,
      port: request.port,
      token: request.token,
      browserToken: request.browserToken,
      appName: request.appName,
      sim: request.sim,
      hid: !request.sim,
      autoSimulator: false,
    });
    service = await starting;
    if (stopping) return;
    send({ type: 'ready', port: service.port, hidAvailable: service.hidAvailable, canExecute: service.canExecute });
  } catch (error) {
    const kind = error instanceof ServiceStartError ? error.kind : 'start-failed';
    send({ type: 'start-error', kind, message: (error as Error).message });
  } finally {
    starting = null;
  }
}

async function stop() {
  if (stopping) return;
  stopping = true;
  const running = service ?? await starting?.catch(() => null) ?? null;
  let saved = true;
  try { if (running) saved = (await running.stop()).saved; }
  catch (error) { console.error('Could not stop cleanly:', (error as Error).message); saved = false; }
  send({ type: 'stopped', saved });
  process.exit(saved ? 0 : 1);
}

/** Repair: recover into a new directory, keep the original aside, then move the copy into place. */
function repair(id: number, dataDir: string, stamp: string) {
  const recovered = `${dataDir}-recovered-${stamp}`;
  const original = `${dataDir}-original-${stamp}`;
  try {
    if (existsSync(original)) throw new Error('A previous repair already used this name. Try again in a moment.');
    const result = recoverDataDir(dataDir, recovered);
    renameSync(dataDir, original);
    try { renameSync(recovered, dataDir); }
    catch (error) { renameSync(original, dataDir); throw error; }
    send({ type: 'repaired', id, ok: true, original, profiles: result.profiles, changes: result.changes });
  } catch (error) {
    send({ type: 'repaired', id, ok: false, message: (error as Error).message });
  }
}

port.on('message', ({ data }) => {
  switch (data?.type) {
    case 'start': void start(data); break;
    case 'stop': void stop(); break;
    case 'setInference': configureInference(data.inference); break;
    case 'repair': repair(data.id, data.dataDir, data.stamp); break;
    case 'testInference': void testInference().then((r) => send({ type: 'inferenceTested', id: data.id, ...r })); break;
  }
});
send({ type: 'hello', pid: process.pid });
