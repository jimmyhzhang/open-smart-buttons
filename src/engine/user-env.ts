// The environment for things the user asked to run: shell commands, scripts, Terminal agents and
// the Claude Code / Codex CLIs. The desktop service starts with a minimal environment, so tools in
// Homebrew, ~/.local/bin or a version manager would be missing. This reads the user's login-shell
// PATH once (bounded, never interactive input) and keeps app credentials out of child processes.

import { spawn } from 'node:child_process';
import { delimiter, isAbsolute, join } from 'node:path';
import { homedir, userInfo } from 'node:os';
import { isAppEnvironmentVariable } from './app-compat.ts';

/** Variables a child never inherits: app credentials and Node/Electron runtime switches. */
const PRIVATE = /^(ANTHROPIC_API_KEY|NODE_OPTIONS|ELECTRON_.*)$/;
const PROBE_TIMEOUT_MS = 5000;
const START = '__OSB_PATH_START__';
const END = '__OSB_PATH_END__';

let probed: string[] | null = null;
let probing: Promise<string[]> | null = null;
let failedAt = 0;
const RETRY_MS = 60_000;

function safeUser(): { name: string; shell: string } {
  try {
    const info = userInfo();
    return { name: info.username, shell: info.shell || '' };
  } catch {
    return { name: process.env.USER || '', shell: '' };
  }
}

/** The user's login shell. */
export function userShell(): string {
  const shell = process.env.SHELL || safeUser().shell;
  return shell && isAbsolute(shell) ? shell : '/bin/zsh';
}

/** Common install locations, used before (and in addition to) the login-shell PATH. */
export function fallbackDirs(home = homedir()): string[] {
  return [
    join(home, '.local', 'bin'), join(home, '.claude', 'local'), join(home, '.npm-global', 'bin'),
    join(home, '.volta', 'bin'), join(home, '.bun', 'bin'), join(home, 'bin'),
    '/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin',
    '/usr/bin', '/bin', '/usr/sbin', '/sbin',
  ];
}

function dedupe(dirs: Iterable<string>): string[] {
  return [...new Set([...dirs].filter((d) => d && isAbsolute(d)))];
}

/** Parse the probe output. Exported for tests. */
export function parseProbe(output: string): string[] | null {
  const start = output.lastIndexOf(START);
  if (start < 0) return null;
  const rest = output.slice(start + START.length);
  const end = rest.indexOf(END);
  if (end < 0) return null;
  const dirs = rest.slice(0, end).split(':').filter((d) => isAbsolute(d));
  return dirs.length ? dirs : null;
}

function probe(): Promise<string[]> {
  if (process.platform !== 'darwin' && process.platform !== 'linux') return Promise.resolve([]);
  const shell = userShell();
  const fish = /\/fish$/.test(shell);
  const script = fish
    ? `printf '${START}%s${END}' (string join : $PATH)`
    : `printf '${START}%s${END}' "$PATH"`;
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const finish = (dirs: string[]) => { if (!done) { done = true; resolve(dirs); } };
    try {
      // -i reads the rc files where version managers usually extend PATH; stdin is closed, so
      // nothing can wait for input, and the timeout bounds slow or broken shell setups.
      const child = spawn(shell, fish ? ['-l', '-i', '-c', script] : ['-ilc', script], {
        stdio: ['ignore', 'pipe', 'ignore'],
        env: { HOME: homedir(), USER: safeUser().name, LOGNAME: safeUser().name, SHELL: shell, LANG: process.env.LANG || 'en_US.UTF-8', TERM: 'dumb' },
        detached: true,
      });
      const timer = setTimeout(() => {
        try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
        finish(parseProbe(out) ?? []);
      }, PROBE_TIMEOUT_MS);
      timer.unref?.();
      child.stdout.on('data', (d: Buffer) => { out = (out + d.toString()).slice(-65536); });
      child.once('error', () => { clearTimeout(timer); finish([]); });
      child.once('close', () => { clearTimeout(timer); finish(parseProbe(out) ?? []); });
    } catch {
      finish([]);
    }
  });
}

/**
 * Read the login-shell PATH. A success is kept for the life of the service; a failure (slow rc files
 * right after login, say) is retried at most once a minute, so a later design or command can still
 * pick up tools from a version manager.
 */
export function warmUserPath(): Promise<string[]> {
  if (probed) return Promise.resolve(probed);
  if (!probing && Date.now() - failedAt < RETRY_MS) return Promise.resolve([]);
  probing ??= probe().then((dirs) => {
    probing = null;
    if (dirs.length) probed = dirs;
    else failedAt = Date.now();
    return dirs;
  });
  return probing;
}

/** Shells whose -lc accepts POSIX command text. Others (fish, nu, tcsh) run commands in zsh. */
export function commandShell(): string {
  const shell = userShell();
  return /\/(zsh|bash|sh)$/.test(shell) ? shell : '/bin/zsh';
}

/**
 * Directories searched for user tools, in order: the login shell's PATH first (as in Terminal), then
 * this process's PATH (the desktop service's is only /usr/bin:/bin:…), then common install locations.
 */
export function userPathDirs(): string[] {
  return dedupe([...(probed ?? []), ...(process.env.PATH ?? '').split(delimiter), ...fallbackDirs()]);
}

/**
 * Environment for a process the user asked to run. Keeps the user's own variables (useful when
 * started from Terminal), removes app credentials, and fills in what the desktop service lacks.
 */
export async function userEnv(extra: Record<string, string> = {}): Promise<NodeJS.ProcessEnv> {
  await warmUserPath();
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !PRIVATE.test(k) && !isAppEnvironmentVariable(k)) env[k] = v;
  const user = safeUser().name;
  env.HOME ||= homedir();
  if (user) { env.USER ||= user; env.LOGNAME ||= user; }
  env.SHELL ||= userShell();
  env.LANG ||= 'en_US.UTF-8';
  env.PATH = userPathDirs().join(delimiter);
  return { ...env, ...extra };
}

/** Test hook: forget the probed PATH. */
export function resetUserPathForTests(dirs: string[] | null = null): void {
  probed = dirs;
  probing = null;
  failedAt = 0;
}
