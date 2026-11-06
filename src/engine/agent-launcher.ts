// Interactive CLI launches only. This module never reads credentials or invokes a model itself.
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';

export type AgentTool = 'codex' | 'claude';
export interface AgentLaunchOptions {
  tool: AgentTool;
  cwd: string;
  prompt?: string;
  mode?: 'new' | 'continue';
}

interface LauncherEnvironment {
  home?: string;
  searchDirs?: readonly string[];
}

export interface AgentAvailability {
  tool: AgentTool;
  name: string;
  installed: boolean;
  executable: string | null;
}

const TOOLS: Record<AgentTool, string> = { codex: 'Codex CLI', claude: 'Claude Code' };

function executableDirs(home: string): string[] {
  return [...new Set([
    ...(process.env.PATH ?? '').split(delimiter),
    join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin',
  ].filter((dir) => isAbsolute(dir)))];
}

function findExecutable(tool: AgentTool, dirs: readonly string[]): string | null {
  for (const dir of dirs) {
    const file = join(dir, tool);
    try {
      if (!statSync(file).isFile()) continue;
      accessSync(file, constants.X_OK);
      return file;
    } catch { /* Try the next directory. */ }
  }
  return null;
}

/** Availability means an executable exists; it does not inspect login state or make network calls. */
export function agentAvailability(env: LauncherEnvironment = {}): AgentAvailability[] {
  const dirs = env.searchDirs ?? executableDirs(env.home ?? homedir());
  return (Object.keys(TOOLS) as AgentTool[]).map((tool) => {
    const executable = findExecutable(tool, dirs);
    return { tool, name: TOOLS[tool], installed: executable !== null, executable };
  });
}

/** Quote one literal argument for the POSIX shell Terminal uses. */
export function quoteShellArg(value: string): string {
  if (value.includes('\0')) throw new Error('Arguments cannot contain a null character');
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export interface PreparedAgentLaunch {
  tool: AgentTool;
  cwd: string;
  executable: string;
  args: string[];
  terminalCommand: string;
}

export function agentWorkingDirectory(value: unknown, home = homedir()): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Choose a working directory for the agent');
  const cwd = resolve(value.replace(/^~(?=\/|$)/, home));
  if (cwd.includes('\0')) throw new Error('The working directory cannot contain a null character');
  try {
    if (!statSync(cwd).isDirectory()) throw new Error();
  } catch {
    throw new Error(`The working directory does not exist or is not a folder: ${cwd}`);
  }
  return cwd;
}

export function prepareAgentLaunch(options: AgentLaunchOptions, env: LauncherEnvironment = {}): PreparedAgentLaunch {
  if (options.tool !== 'codex' && options.tool !== 'claude') throw new Error('Choose Codex CLI or Claude Code');
  const mode = options.mode ?? 'new';
  if (mode !== 'new' && mode !== 'continue') throw new Error('Choose a new session or continue the last session');
  const home = env.home ?? homedir();
  const cwd = agentWorkingDirectory(options.cwd, home);
  if (options.prompt !== undefined && typeof options.prompt !== 'string') throw new Error('The agent prompt must be text');
  const prompt = options.prompt ?? '';
  if (prompt.includes('\0')) throw new Error('The agent prompt cannot contain a null character');
  if (mode === 'continue' && prompt.trim()) throw new Error('Continue resumes the last session without a new prompt. Choose New session to send this prompt.');
  const executable = findExecutable(options.tool, env.searchDirs ?? executableDirs(home));
  if (!executable) throw new Error(`${TOOLS[options.tool]} was not found. Install it and restart StreamDeckPlus so it can see your PATH.`);
  const args = options.tool === 'codex'
    ? ['--cd', cwd, '--sandbox', 'workspace-write', '--ask-for-approval', 'on-request', ...(mode === 'continue' ? ['resume', '--last'] : [])]
    : ['--permission-mode', 'default', ...(mode === 'continue' ? ['--continue'] : [])];
  // A leading -- in a user's prompt must remain prompt text, never become an agent option.
  if (mode === 'new' && prompt.trim()) args.push('--', prompt);
  const terminalCommand = `cd -- ${quoteShellArg(cwd)} && exec ${[executable, ...args].map(quoteShellArg).join(' ')}`;
  return { tool: options.tool, cwd, executable, args, terminalCommand };
}

// The command is an argv value, never AppleScript source. Shell quoting happens once above.
export const TERMINAL_LAUNCH_SCRIPT = `on run argv
  tell application "Terminal"
    do script (item 1 of argv)
    activate
  end tell
end run`;
