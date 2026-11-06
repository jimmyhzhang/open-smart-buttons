import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { findExecutable } from './agent-launcher.ts';
import { userEnv, userPathDirs } from './user-env.ts';
import { BUTTON_SCHEMA, type ButtonAgentProvider, type ButtonProposal } from '../shared/button-agent.ts';
export type ButtonRunner = (provider: ButtonAgentProvider, prompt: string, workspace: string, signal: AbortSignal) => Promise<ButtonProposal>;
export function boundedProcess(executable: string, args: string[], cwd: string, input: string, signal: AbortSignal, timeout = 180_000, env?: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('Cancelled'));
    const child = spawn(executable, args, { cwd, env, detached: process.platform !== 'win32', stdio: ['pipe','pipe','pipe'] });
    let out = '', err = '', failure: Error | undefined;
    const kill = () => { try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch {} };
    const cancel = () => { failure = new Error('Cancelled'); kill(); };
    signal.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => { failure = new Error('The agent timed out. Try a smaller request or check its sign-in.'); kill(); }, timeout);
    const collect = (chunk: Buffer, stderr: boolean) => { if (stderr) err += chunk.toString(); else out += chunk.toString(); if (out.length + err.length > 2_000_000) { failure = new Error('Agent output exceeded the limit'); kill(); } };
    child.stdout.on('data', c => collect(c, false)); child.stderr.on('data', c => collect(c, true));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
    child.once('error', e => { failure = e; });
    child.once('close', code => { clearTimeout(timer); signal.removeEventListener('abort', cancel); if (failure) reject(failure); else if (code !== 0) { let detail=(err || out).slice(-1200); try { const result=JSON.parse(out); if(typeof result.result==='string') detail=result.result; } catch {} reject(new Error(`Agent exited (${code}): ${detail}`)); } else resolve(out); });
  });
}
// Codex tools that could run commands, read files or reach other services. Turned off so a design
// run can only answer with text; names a Codex version doesn't know are ignored.
const CODEX_TOOLS_OFF = [
  'shell_tool', 'unified_exec', 'apps', 'plugins', 'remote_plugin', 'browser_use', 'browser_use_external',
  'in_app_browser', 'computer_use', 'image_generation', 'view_image', 'multi_agent', 'hooks', 'tool_suggest',
].flatMap((feature) => ['-c', `features.${feature}=false`]);

/** Runs Claude Code or Codex once, with no tools, no MCP servers and no saved session. Sign-in problems are explained by ai-engines.ts. */
export const runButtonAgent = async (provider: 'claude' | 'codex', prompt: string, workspace: string = tmpdir(), signal: AbortSignal): Promise<ButtonProposal> => {
  const name = provider === 'codex' ? 'Codex' : 'Claude Code';
  const executable = findExecutable(provider, userPathDirs());
  if (!executable) throw new Error(`${name} isn't installed. Install it, or choose another engine in Settings ▸ AI.`);
  // The user's own CLI sign-in. The app's API key is never passed, so Claude Code uses the subscription.
  const env = await userEnv(provider === 'claude' ? { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' } : {});
  const dir = mkdtempSync(join(workspace, 'run-'));
  try {
    writeFileSync(join(dir, 'schema.json'), JSON.stringify(BUTTON_SCHEMA));
    if (provider === 'codex') {
      await boundedProcess(executable, ['exec','--ignore-user-config','--ignore-rules','--ephemeral','--skip-git-repo-check','--sandbox','read-only',...CODEX_TOOLS_OFF,'-c','web_search="disabled"','--color','never','--output-schema',join(dir,'schema.json'),'-o',join(dir,'result.json'),'-'], dir, prompt, signal, undefined, env);
      return JSON.parse(readFileSync(join(dir,'result.json'),'utf8'));
    }
    const raw = await boundedProcess(executable, ['--safe-mode','-p','--tools','','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--no-session-persistence','--output-format','json','--json-schema',JSON.stringify(BUTTON_SCHEMA)], dir, prompt, signal, undefined, env);
    const envelope = JSON.parse(raw);
    if (envelope.is_error) throw new Error(String(envelope.result || 'Claude Code could not complete the request'));
    return envelope.structured_output ?? JSON.parse(envelope.result);
  } finally { rmSync(dir, { recursive: true, force: true }); }
};
