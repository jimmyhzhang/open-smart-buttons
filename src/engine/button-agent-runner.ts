import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { agentAvailability } from './agent-launcher.ts';
import { BUTTON_SCHEMA, type ButtonAgentProvider, type ButtonProposal } from '../shared/button-agent.ts';
export type ButtonRunner = (provider: ButtonAgentProvider, prompt: string, workspace: string, signal: AbortSignal) => Promise<ButtonProposal>;
export function boundedProcess(executable: string, args: string[], cwd: string, input: string, signal: AbortSignal, timeout = 180_000): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('Cancelled'));
    const child = spawn(executable, args, { cwd, detached: process.platform !== 'win32', stdio: ['pipe','pipe','pipe'] });
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
export const runButtonAgent: ButtonRunner = async (provider, prompt, workspace, signal) => {
  const executable = agentAvailability().find(a => a.tool === provider)?.executable;
  if (!executable) throw new Error(`Install ${provider === 'codex' ? 'Codex CLI' : 'Claude Code'} and sign in before creating a button.`);
  const dir = mkdtempSync(join(workspace, 'run-'));
  try {
    writeFileSync(join(dir, 'schema.json'), JSON.stringify(BUTTON_SCHEMA));
    if (provider === 'codex') {
      await boundedProcess(executable, ['exec','--ignore-user-config','--ignore-rules','--ephemeral','--skip-git-repo-check','--sandbox','read-only','--color','never','--output-schema',join(dir,'schema.json'),'-o',join(dir,'result.json'),'-'], dir, prompt, signal);
      return JSON.parse(readFileSync(join(dir,'result.json'),'utf8'));
    }
    const raw = await boundedProcess(executable, ['--safe-mode','-p','--tools','','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--no-session-persistence','--output-format','json','--json-schema',JSON.stringify(BUTTON_SCHEMA)], dir, prompt, signal);
    const envelope = JSON.parse(raw);
    if (envelope.is_error) throw new Error(String(envelope.result || 'Claude Code could not complete the request'));
    return envelope.structured_output ?? JSON.parse(envelope.result);
  } finally { rmSync(dir, { recursive: true, force: true }); }
};
