// Opt-in live inference check. Uses a disposable Neo simulator and never controls the Mac.
//   node src/tools/button-agent-smoke.ts [auto|claude|codex|api]
// API mode reads ANTHROPIC_API_KEY and STREAMDECK_CLAUDE_MODEL from the local environment.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ButtonAgent } from '../engine/button-agent.ts';
import { Store } from '../engine/store.ts';
import { Engine } from '../engine/engine.ts';
import { DeviceManager } from '../device/manager.ts';
import { configureInference } from '../engine/inference.ts';
import { isAiPreference, resolveEngine, setAiPreference } from '../engine/ai-engines.ts';
import { activeButtonJob, type ButtonJob } from '../shared/button-agent.ts';

const preference = process.argv[2] ?? process.env.STREAMDECK_AI ?? 'auto';
if (!isAiPreference(preference)) throw new Error('Choose auto, claude, codex, or api.');
configureInference({ apiKey: process.env.ANTHROPIC_API_KEY, model: process.env.STREAMDECK_CLAUDE_MODEL });
delete process.env.ANTHROPIC_API_KEY;
setAiPreference(preference);
const provider = await resolveEngine();
const dir = mkdtempSync(join(tmpdir(), 'sdp-live-agent-'));
const store = new Store(dir);
store.config.settings.executeActions = false;
const manager = new DeviceManager();
const engine = new Engine(store, manager, true);
const service = new ButtonAgent(engine);

async function finish(job: ButtonJob): Promise<ButtonJob> {
  const deadline = Date.now() + 200_000;
  while (Date.now() < deadline) {
    const current = service.list().find(current => current.id === job.id)!;
    if (!activeButtonJob(current.status)) {
      assert.equal(current.status, 'ready', current.error || current.summary || 'The live design did not produce a button.');
      return current;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('The live design did not finish before the smoke-test deadline.');
}

try {
  const dev = await manager.addSimulator('neo');
  const session = engine.sessions.get(dev.id)!;
  const target = { profileId: session.profileId, pageId: session.pageId, kind: 'key' as const, index: 4 };
  await finish(service.start(target,
    'Create a built-in counter called Focus Count that increments once per press. Use a real Lucide icon. No scripts.', provider));
  const page = store.profile(session.profileId)!.pages[session.pageId]!;
  const created = structuredClone(page.keys[4]!);
  assert.equal(created.type, 'util.counter');
  await engine.testAction(dev.id, 'key', 4);
  assert.equal(engine.stateFor(created.id, session.dev).n, 1);

  const edited = await finish(service.start(target,
    'Keep this as a built-in counter. Change the step to 3 and the title to Three Count. No scripts.', provider, created.id));
  assert.equal(page.keys[4]!.settings.step, 3);
  await engine.testAction(dev.id, 'key', 4);
  assert.equal(engine.stateFor(page.keys[4]!.id, session.dev).n, 3);
  service.undo(edited.id);
  assert.deepEqual(page.keys[4], created);
  console.log(JSON.stringify({ provider, create: 'passed', edit: 'passed', press: 'passed', undo: 'passed' }));
} finally {
  service.close();
  await manager.stop();
  store.flush();
  rmSync(dir, { recursive: true, force: true });
}
