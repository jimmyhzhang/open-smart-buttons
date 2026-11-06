// StreamDeckPlus CLI: parse flags, start the embeddable service, print the editor link.
//   node src/server/main.ts [--port 4417] [--sim] [--no-hid] [--data DIR] [--open] [--dev]

import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { defaultDataDir } from '../engine/store.ts';
import { configureInference } from '../engine/inference.ts';
import { setAiPreference } from '../engine/ai-engines.ts';
import { HOST, ServiceStartError, startService } from './service.ts';

// Hand the credential to the inference adapter, then keep it out of child process environments.
configureInference({ apiKey: process.env.ANTHROPIC_API_KEY, model: process.env.STREAMDECK_CLAUDE_MODEL });
delete process.env.ANTHROPIC_API_KEY;
// AI engine: automatic (Claude Code, then Codex, then the API key) unless STREAMDECK_AI names one.
setAiPreference(process.env.STREAMDECK_AI);

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(`--${n}`);
const opt = (n: string, d: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] ? args[i + 1]! : d;
};

const port = Number(opt('port', process.env.PORT || '4417'));
if (!Number.isInteger(port) || port < 1 || port > 65535 || opt('host', HOST) !== HOST) {
  throw new Error('Choose a valid port and the loopback host 127.0.0.1.');
}
const dataDir = resolve(flag('data') ? opt('data', defaultDataDir()) : defaultDataDir());

process.on('unhandledRejection', (e) => console.error('unhandled:', e));

// Install signal handlers before anything is started: a signal that arrives during startup or right
// after the link is printed must still stop cleanly (flush, release USB, lock and token files).
let service: Awaited<ReturnType<typeof startService>> | undefined;
let starting: ReturnType<typeof startService> | undefined;
let closing = false;
const shutdown = async () => {
  if (closing) return;
  closing = true;
  const running = service ?? await starting?.catch(() => undefined);
  let exitCode = 0;
  try { if (running) exitCode = (await running.stop()).saved ? 0 : 1; }
  catch (error) { console.error('Could not stop cleanly:', (error as Error).message); exitCode = 1; }
  process.exit(exitCode);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

try {
  starting = startService({ dataDir, port, sim: flag('sim'), hid: !flag('no-hid') && !flag('sim'), dev: flag('dev') });
  service = await starting;
} catch (error) {
  if (closing) process.exit(1);
  if (error instanceof ServiceStartError && error.kind === 'config-invalid') {
    console.error(`${error.message}\nRun npm run recover -- "${dataDir}" "${dataDir}-recovered" to repair a copy (the second folder must not exist yet), or restore a backup.`);
  } else {
    console.error(error instanceof ServiceStartError ? error.message : error);
  }
  process.exit(1);
}
if (closing) await new Promise(() => {}); // shutdown() owns the exit now

console.log(`Open the editor at ${service.url}`);
console.log(`  data: ${service.dataDir}`);
console.log(`  HID: ${service.hidAvailable ? 'available' : 'unavailable (simulator only)'}; actions: ${service.canExecute ? 'live' : 'dry-run'}`);
if (flag('open')) execFile(process.platform === 'darwin' ? '/usr/bin/open' : 'xdg-open', [service.url]);

