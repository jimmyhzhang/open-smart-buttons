// Opt-in Claude inference smoke test with a disposable Neo simulator.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ButtonAgent } from '../engine/button-agent.ts';
import { Store } from '../engine/store.ts';
import { Engine } from '../engine/engine.ts';
import { DeviceManager } from '../device/manager.ts';
import { inferenceAvailable, runInference } from '../engine/inference.ts';
if (!inferenceAvailable()) throw new Error('Configure Claude API before starting the smoke test.');
const provider = 'claude';
const dir = mkdtempSync(join(tmpdir(), 'sdp-live-agent-'));
const store = new Store(dir);
store.config.settings.executeActions = false;
const manager = new DeviceManager();
const engine = new Engine(store, manager, true);
const service = new ButtonAgent(engine, runInference);
try {
  const dev = await manager.addSimulator('neo');
  const session = engine.sessions.get(dev.id)!;
  const job = service.start({ profileId: session.profileId, pageId: session.pageId, kind: 'key', index: 4 },
    'Create a counter button called Focus count, increment once each time I press it. Use a built-in action. Do not run tools or shell commands.', provider);
  console.log(JSON.stringify({ dir, provider, id: job.id }));
  let status = '';
  for (;;) {
    const current = service.list().at(-1)!;
    if (current.status !== status) { console.log(JSON.stringify(current)); status = current.status; }
    if (!['creating', 'validating', 'repairing'].includes(status)) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  const result = service.list().at(-1)!;
  let pressedCounter: number | undefined;
  if (result.status === 'ready') {
    session.handleKey(4, true); session.handleKey(4, false);
    pressedCounter = engine.stateFor(store.profile(session.profileId)!.pages[session.pageId]!.keys[4]!.id).n as number;
    assert.equal(pressedCounter, 1, 'Generated counter increments once');
  } else process.exitCode = 1;
  console.log(JSON.stringify({ status: result.status, pressedCounter }));
} finally {
  service.close(); await manager.stop(); store.flush();
  rmSync(dir, { recursive: true, force: true });
}
