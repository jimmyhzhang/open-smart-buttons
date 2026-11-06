import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { aiStatus, invalidateAiEngines, pickEngine, resolveEngine, setAiPreference, unavailableMessage } from '../src/engine/ai-engines.ts';
import { configureInference } from '../src/engine/inference.ts';
import { resetUserPathForTests } from '../src/engine/user-env.ts';
import type { AiEngine } from '../src/shared/button-agent.ts';

const engine = (id: AiEngine['id'], status: AiEngine['status']): AiEngine => ({ id, name: id, vendor: 'v', status, detail: '', executable: null });

test('automatic picks Claude Code, then Codex, then the API key; an explicit choice is kept', () => {
  const all = [engine('claude', 'ready'), engine('codex', 'ready'), engine('api', 'ready')];
  assert.equal(pickEngine(all, 'auto')?.id, 'claude');
  assert.equal(pickEngine([engine('claude', 'signed-out'), engine('codex', 'ready'), engine('api', 'ready')], 'auto')?.id, 'codex');
  assert.equal(pickEngine([engine('claude', 'missing'), engine('codex', 'signed-out'), engine('api', 'ready')], 'auto')?.id, 'api');
  assert.equal(pickEngine([engine('claude', 'missing'), engine('codex', 'missing'), engine('api', 'not-configured')], 'auto'), null);
  assert.equal(pickEngine(all, 'api')?.id, 'api');
  assert.match(unavailableMessage([engine('claude', 'signed-out')], 'claude'), /isn't signed in.*`claude`/);
  assert.match(unavailableMessage([engine('codex', 'missing')], 'codex'), /isn't installed/);
  assert.match(unavailableMessage([], 'auto'), /Sign in to Claude Code or Codex, or add an Anthropic API key/);
});

test('CLI sign-in status comes from each CLI and drives the chosen engine', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-engines-'));
  const saved = process.env.PATH;
  t.after(() => { process.env.PATH = saved; resetUserPathForTests(null); setAiPreference('auto'); configureInference({}); invalidateAiEngines(); rmSync(dir, { recursive: true, force: true }); });
  const fake = (name: string, body: string) => writeFileSync(join(dir, name), `#!${process.execPath}\n${body}`, { mode: 0o700 });
  fake('claude', `if (process.argv[2]==='auth') console.log(JSON.stringify({loggedIn:false}));`);
  fake('codex', `if (process.argv[2]==='login') { console.log('Logged in using ChatGPT'); process.exit(0); }`);
  process.env.PATH = dir;
  resetUserPathForTests([]);
  invalidateAiEngines();
  configureInference({ apiKey: 'k', model: 'm' });

  let status = await aiStatus(true);
  assert.deepEqual(status.engines.map((e) => [e.id, e.status]), [['claude', 'signed-out'], ['codex', 'ready'], ['api', 'ready']]);
  assert.equal(status.engines[1]!.detail, 'Signed in with ChatGPT.');
  assert.equal(status.active, 'codex');
  assert.equal(await resolveEngine(), 'codex');

  setAiPreference('claude');
  await assert.rejects(resolveEngine(), /Claude Code isn't signed in/);
  assert.equal(await resolveEngine('api'), 'api', 'a request may name a ready engine');

  // Signing in is noticed on the next design without restarting.
  fake('claude', `if (process.argv[2]==='auth') console.log(JSON.stringify({loggedIn:true,subscriptionType:'max'}));`);
  assert.equal(await resolveEngine(), 'claude');
  status = await aiStatus();
  assert.equal(status.engines[0]!.detail, 'Signed in with Claude Max.');

  setAiPreference('nonsense');
  assert.equal((await aiStatus()).preference, 'auto');
});
