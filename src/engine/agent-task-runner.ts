import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { agentWorkingDirectory, findExecutable } from './agent-launcher.ts';
import { boundedProcess } from './button-agent-runner.ts';
import { userEnv, userPathDirs } from './user-env.ts';
import type { AgentTaskInput } from '../shared/agent-task.ts';

export type AgentTaskRunner = (input: AgentTaskInput, signal: AbortSignal) => Promise<string>;
const TIMEOUT_MS = 30 * 60_000;
const OUTPUT_LIMIT = 64 * 1024;

export function agentTaskArguments(tool: AgentTaskInput['tool'], resultFile: string): string[] {
  return tool === 'codex'
    ? ['exec', '--sandbox', 'workspace-write', '-c', 'approval_policy="never"', '--skip-git-repo-check', '--color', 'never', '--json', '--output-last-message', resultFile, '-']
    : ['--print', '--output-format', 'json'];
}

export const runAgentTask: AgentTaskRunner = async (input, signal) => {
  if (signal.aborted) throw new Error('Cancelled');
  if (!['claude', 'codex'].includes(input.tool)) throw new Error('Choose Claude Code or Codex.');
  const cwd = agentWorkingDirectory(input.cwd);
  if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.includes('\0')) throw new Error('Enter a prompt for this button.');
  const env = await userEnv(input.tool === 'claude' ? { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' } : {});
  const executable = findExecutable(input.tool, userPathDirs());
  if (!executable) throw new Error(`${input.tool === 'claude' ? 'Claude Code' : 'Codex'} is not installed. Choose another CLI or install it first.`);
  const dir = mkdtempSync(join(tmpdir(), 'osb-agent-task-'));
  try {
    const resultFile = join(dir, 'response.txt');
    const raw = await boundedProcess(executable, agentTaskArguments(input.tool, resultFile), cwd, input.prompt, signal, TIMEOUT_MS, env);
    if (input.tool === 'codex') {
      let output: string;
      try { output = readFileSync(resultFile, 'utf8'); }
      catch { throw new Error('Codex finished without a final response. Check its sign-in and project settings.'); }
      return output.slice(-OUTPUT_LIMIT);
    }
    const result = JSON.parse(raw) as { is_error?: boolean; result?: string; permission_denials?: { tool_name?: string }[] };
    if (result.is_error) throw new Error(result.result || 'Claude Code could not complete the prompt.');
    if (result.permission_denials?.length) throw new Error('Claude Code needs permission for this task. Choose Terminal in this button’s setup to approve it interactively.');
    if (typeof result.result !== 'string') throw new Error('Claude Code finished without a final response.');
    return result.result.slice(-OUTPUT_LIMIT);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};
