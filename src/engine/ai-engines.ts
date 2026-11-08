// Which AI designs buttons. Claude Code and Codex use the sign-in you already have in those CLIs,
// so there is nothing to set up; an Anthropic API key is the fallback. "Automatic" picks the first
// ready engine in that order. Status checks only run each CLI's local sign-in status command.

import { execFile } from 'node:child_process';
import { findExecutable } from './agent-launcher.ts';
import { runButtonAgent } from './button-agent-runner.ts';
import type { ButtonRunner } from './button-agent-runner.ts';
import { inferenceAvailable, inferenceModel, runInference, testInference } from './inference.ts';
import { userEnv, userPathDirs, warmUserPath } from './user-env.ts';
import { AI_ENGINE_ORDER, aiEngineName, type AiEngine, type AiPreference, type AiStatus, type ButtonAgentProvider } from '../shared/button-agent.ts';

const STATUS_TIMEOUT_MS = 8000;
const CACHE_MS = 60_000;

let preference: AiPreference = 'auto';
let cache: { at: number; engines: AiEngine[] } | null = null;
let pending: Promise<AiEngine[]> | null = null;

export function isAiPreference(value: unknown): value is AiPreference {
  return value === 'auto' || (AI_ENGINE_ORDER as readonly unknown[]).includes(value);
}

/** Set from Settings ▸ AI in the app, or OPEN_SMART_BUTTONS_AI from Terminal. Unknown values mean automatic. */
export function setAiPreference(value: unknown): void {
  preference = isAiPreference(value) ? value : 'auto';
}

export function aiPreference(): AiPreference {
  return preference;
}

/** Forget cached sign-in status (after the API key changes, or when the user asks to check again). */
export function invalidateAiEngines(): void {
  cache = null;
}

function run(executable: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return userEnv().then((env) => new Promise((resolve) => {
    execFile(executable, args, { env, timeout: STATUS_TIMEOUT_MS, maxBuffer: 256 * 1024, encoding: 'utf8' }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
      resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  }));
}

const PLAN_NAMES: Record<string, string> = { max: 'Claude Max', pro: 'Claude Pro', team: 'Claude Team', enterprise: 'Claude Enterprise' };

async function claudeStatus(): Promise<AiEngine> {
  const executable = findExecutable('claude', userPathDirs());
  const base = { id: 'claude' as const, name: aiEngineName.claude, vendor: 'Anthropic', executable };
  if (!executable) return { ...base, status: 'missing', detail: 'Not installed.' };
  const r = await run(executable, ['auth', 'status']);
  try {
    const s = JSON.parse(r.stdout) as { loggedIn?: boolean; authMethod?: string; subscriptionType?: string; apiProvider?: string };
    if (s.loggedIn) {
      const plan = s.subscriptionType && PLAN_NAMES[s.subscriptionType];
      return { ...base, status: 'ready', detail: plan ? `Signed in with ${plan}.` : 'Signed in.' };
    }
    return { ...base, status: 'signed-out', detail: 'Installed, but not signed in.' };
  } catch {
    // Older versions print text. Exit status 0 means signed in.
    return r.code === 0 ? { ...base, status: 'ready', detail: 'Signed in.' } : { ...base, status: 'signed-out', detail: 'Installed, but not signed in.' };
  }
}

async function codexStatus(): Promise<AiEngine> {
  const executable = findExecutable('codex', userPathDirs());
  const base = { id: 'codex' as const, name: aiEngineName.codex, vendor: 'OpenAI', executable };
  if (!executable) return { ...base, status: 'missing', detail: 'Not installed.' };
  const r = await run(executable, ['login', 'status']);
  if (r.code !== 0) return { ...base, status: 'signed-out', detail: 'Installed, but not signed in.' };
  const how = /using (ChatGPT|an API key)/i.exec(`${r.stdout}\n${r.stderr}`)?.[1];
  return { ...base, status: 'ready', detail: how ? `Signed in with ${/chatgpt/i.test(how) ? 'ChatGPT' : 'an API key'}.` : 'Signed in.' };
}

function apiStatus(): AiEngine {
  const base = { id: 'api' as const, name: aiEngineName.api, vendor: 'Anthropic', executable: null };
  return inferenceAvailable()
    ? { ...base, status: 'ready', detail: `Key added. Model: ${inferenceModel()}.` }
    : { ...base, status: 'not-configured', detail: 'No key added.' };
}

/** Every engine with its status, in preference order. Cached for a minute; `refresh` checks again. */
export async function aiEngines(refresh = false): Promise<AiEngine[]> {
  if (!refresh && cache && Date.now() - cache.at < CACHE_MS) return withApi(cache.engines);
  pending ??= (async () => {
    await warmUserPath();
    const [claude, codex] = await Promise.all([claudeStatus(), codexStatus()]);
    cache = { at: Date.now(), engines: [claude, codex] };
    return cache.engines;
  })().finally(() => { pending = null; });
  return withApi(await pending);
}

// The API key can change at any time; its status is never cached.
function withApi(engines: AiEngine[]): AiEngine[] {
  return [...engines.filter((e) => e.id !== 'api'), apiStatus()];
}

/** The engine a new design uses: the chosen one, or the first ready one when automatic. */
export function pickEngine(engines: AiEngine[], pref: AiPreference = preference): AiEngine | null {
  if (pref !== 'auto') return engines.find((e) => e.id === pref) ?? null;
  return AI_ENGINE_ORDER.map((id) => engines.find((e) => e.id === id)).find((e) => e?.status === 'ready') ?? null;
}

export async function aiStatus(refresh = false): Promise<AiStatus> {
  const engines = await aiEngines(refresh);
  const active = pickEngine(engines);
  const ready = active?.status === 'ready';
  return { preference, engines, active: ready ? active.id : null, ...(ready ? {} : { message: unavailableMessage(engines) }) };
}

/** Explains why no engine can design right now, in words a user can act on. */
export function unavailableMessage(engines: AiEngine[], pref: AiPreference = preference): string {
  if (pref !== 'auto') {
    const chosen = engines.find((e) => e.id === pref);
    if (chosen?.status === 'missing') return `${chosen.name} isn't installed. Install it, or choose another engine in Settings ▸ AI.`;
    if (chosen?.status === 'signed-out') return `${chosen.name} isn't signed in. Run \`${chosen.id === 'codex' ? 'codex login' : 'claude'}\` in Terminal and sign in, then try again.`;
    if (chosen?.status === 'not-configured') return 'Add an Anthropic API key in Settings ▸ AI, or choose another engine.';
  }
  return 'Sign in to Claude Code or Codex, or add an Anthropic API key in Settings ▸ AI.';
}

/** Resolve the engine for a new design; throws a readable message when none is ready. */
export async function resolveEngine(requested?: unknown): Promise<ButtonAgentProvider> {
  let engines = await aiEngines();
  const pref = isAiPreference(requested) && requested !== 'auto' ? requested : preference;
  let engine = pickEngine(engines, pref);
  if (engine?.status !== 'ready') {
    // The user may have just signed in; check again before refusing.
    engines = await aiEngines(true);
    engine = pickEngine(engines, pref);
  }
  if (engine?.status !== 'ready') throw new Error(unavailableMessage(engines, pref));
  return engine.id;
}

/**
 * Runs a CLI design. When it fails, the CLI's own sign-in status (not the error text, which can echo
 * the prompt) decides whether to say "sign in".
 */
async function runCli(provider: 'claude' | 'codex', prompt: string, workspace: string | undefined, signal: AbortSignal) {
  try {
    return await runButtonAgent(provider, prompt, workspace, signal);
  } catch (error) {
    if (signal.aborted || /timed out|cancelled/i.test((error as Error).message)) throw error;
    const engine = (await aiEngines(true)).find((e) => e.id === provider);
    if (engine && engine.status !== 'ready') throw new Error(unavailableMessage([engine], provider));
    throw error;
  }
}

/** Runs a design with the engine recorded on the job. */
export const runAi: ButtonRunner = (provider, prompt, workspace, signal) =>
  provider === 'api' ? runInference(provider, prompt, workspace, signal) : runCli(provider, prompt, workspace, signal);

/** Settings ▸ AI ▸ Test: a tiny request through the engine new designs would use. */
export async function testAi(): Promise<{ ok: boolean; message: string }> {
  let id: ButtonAgentProvider;
  try { id = await resolveEngine(); } catch (e) { return { ok: false, message: (e as Error).message }; }
  if (id === 'api') return testInference();
  const started = Date.now();
  try {
    await runCli(id, 'Return a button titled OK with icon check, color #0f172a, type util.counter, settingsJson {}, statesJson [], an empty script, and summary OK.', undefined, AbortSignal.timeout(90_000));
    return { ok: true, message: `${aiEngineName[id]} answered in ${((Date.now() - started) / 1000).toFixed(1)} s.` };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}
