import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { agentAvailability, prepareAgentLaunch, quoteShellArg, TERMINAL_LAUNCH_SCRIPT } from '../src/engine/agent-launcher.ts';
import { DryRunPlatform, MacPlatform, PermissionError } from '../src/engine/platform.ts';

const exec = promisify(execFile);

function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), 'sdp-agent-launcher-'));
  const bin = join(root, 'bin');
  const cwd = join(root, "project 'quoted' $literal; spaces");
  mkdirSync(bin);
  mkdirSync(cwd);
  // These executables only record argv. Tests never start a real CLI session or model call.
  for (const name of ['codex', 'claude']) {
    writeFileSync(join(bin, name), `#!${process.execPath}\nconsole.log(JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2)}));\n`, { mode: 0o755 });
  }
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, bin, cwd, env: { searchDirs: [bin] } };
}

test('Codex launch uses the chosen directory, workspace sandbox and ordinary interactive approvals', (t) => {
  const { bin, cwd, env } = fixture(t);
  const launch = prepareAgentLaunch({ tool: 'codex', cwd, prompt: '--dangerously-bypass-approvals-and-sandbox' }, env);
  assert.equal(launch.executable, join(bin, 'codex'));
  assert.deepEqual(launch.args, [
    '--cd', cwd, '--sandbox', 'workspace-write', '--ask-for-approval', 'on-request',
    '--', '--dangerously-bypass-approvals-and-sandbox',
  ]);
  assert.deepEqual(prepareAgentLaunch({ tool: 'codex', cwd }, env).args,
    ['--cd', cwd, '--sandbox', 'workspace-write', '--ask-for-approval', 'on-request']);
  assert.deepEqual(prepareAgentLaunch({ tool: 'codex', cwd, mode: 'continue' }, env).args,
    ['--cd', cwd, '--sandbox', 'workspace-write', '--ask-for-approval', 'on-request', 'resume', '--last']);
});

test('Claude launch retains ordinary permissions, handles option-looking prompts and continues without a prompt', (t) => {
  const { cwd, env } = fixture(t);
  assert.deepEqual(prepareAgentLaunch({ tool: 'claude', cwd, prompt: '--dangerously-skip-permissions' }, env).args,
    ['--permission-mode', 'default', '--', '--dangerously-skip-permissions']);
  assert.deepEqual(prepareAgentLaunch({ tool: 'claude', cwd, mode: 'continue' }, env).args,
    ['--permission-mode', 'default', '--continue']);
  assert.equal(prepareAgentLaunch({ tool: 'claude', cwd: '~' }, { ...env, home: cwd }).cwd, cwd);
});

test('Terminal shell round trip preserves prompt/cwd metacharacters and cannot execute prompt text', async (t) => {
  const { root, cwd, env } = fixture(t);
  const marker = join(root, 'injected');
  const prompt = `--model fake; touch ${marker}; $(touch ${marker}) \`touch ${marker}\` '$HOME' "quote"\nnew line\tUnicode: ☕`;
  for (const tool of ['codex', 'claude'] as const) {
    const launch = prepareAgentLaunch({ tool, cwd, prompt }, env);
    const result = await exec('/bin/sh', ['-c', launch.terminalCommand]);
    assert.deepEqual(JSON.parse(result.stdout), { cwd: realpathSync(cwd), args: launch.args });
    assert.equal(JSON.parse(result.stdout).args.at(-1), prompt);
    assert.equal(existsSync(marker), false, 'prompt text was not run as a shell command');
  }
});

test('launcher validates tool, working folder, prompt and continuation before any execution', (t) => {
  const { cwd, bin, root, env } = fixture(t);
  const base = { tool: 'codex' as const, cwd };
  assert.throws(() => prepareAgentLaunch({ ...base, tool: 'unknown' as any }, env), /Choose Codex/);
  assert.throws(() => prepareAgentLaunch({ ...base, cwd: '' }, env), /working directory/);
  assert.throws(() => prepareAgentLaunch({ ...base, cwd: join(root, 'missing') }, env), /does not exist/);
  assert.throws(() => prepareAgentLaunch({ ...base, cwd: join(bin, 'codex') }, env), /not a folder/);
  assert.throws(() => prepareAgentLaunch({ ...base, cwd: '\0' }, env), /null character/);
  assert.throws(() => prepareAgentLaunch({ ...base, mode: 'bad' as any }, env), /new session/);
  assert.throws(() => prepareAgentLaunch({ ...base, prompt: 123 as any }, env), /must be text/);
  assert.throws(() => prepareAgentLaunch({ ...base, prompt: '\0' }, env), /null character/);
  assert.throws(() => prepareAgentLaunch({ ...base, mode: 'continue', prompt: 'new task' }, env), /without a new prompt/);
  assert.throws(() => prepareAgentLaunch(base, { searchDirs: [] }), /not found/);
  assert.throws(() => quoteShellArg('\0'), /null character/);
});

test('availability only checks local executables and ignores a non-executable CLI', (t) => {
  const { bin, env } = fixture(t);
  chmodSync(join(bin, 'claude'), 0o644);
  assert.deepEqual(agentAvailability(env), [
    { tool: 'codex', name: 'Codex CLI', installed: true, executable: join(bin, 'codex') },
    { tool: 'claude', name: 'Claude Code', installed: false, executable: null },
  ]);
});

test('macOS sends the quoted command as AppleScript argv and identifies Terminal permission errors', async (t) => {
  const { bin, cwd } = fixture(t);
  const previousPath = process.env.PATH;
  process.env.PATH = bin;
  try {
    const calls: { cmd: string; args: string[] }[] = [];
    const platform = new MacPlatform(async (cmd, args) => {
      calls.push({ cmd, args });
      return { code: 0, stdout: '', stderr: '' };
    });
    const prompt = 'A prompt with "quotes" and $(literal)';
    await platform.launchAgent({ tool: 'codex', cwd, prompt });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.cmd, 'osascript');
    assert.deepEqual(calls[0]!.args.slice(0, 2), ['-e', TERMINAL_LAUNCH_SCRIPT]);
    assert.equal(calls[0]!.args[1]!.includes(prompt), false, 'the prompt is not AppleScript source');
    assert.equal(calls[0]!.args[2], prepareAgentLaunch({ tool: 'codex', cwd, prompt }).terminalCommand);
    const blocked = new MacPlatform(async () => ({ code: 1, stdout: '', stderr: 'Not authorized to send Apple events (-1743)' }));
    await assert.rejects(blocked.launchAgent({ tool: 'codex', cwd }), (error) =>
      error instanceof PermissionError && error.permission === 'automation' && /control Terminal/.test(error.message));
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
});

test('a Terminal Automation denial preserves the separately verified System Events permission', async (t) => {
  const { bin, cwd } = fixture(t);
  const previousPath = process.env.PATH;
  process.env.PATH = bin;
  try {
    let systemEventsChecks = 0;
    const platform = new MacPlatform(async (_cmd, args) => {
      if (args[1] === TERMINAL_LAUNCH_SCRIPT) {
        return { code: 1, stdout: '', stderr: 'Not authorized to send Apple events (-1743)' };
      }
      if (args.at(-1)?.includes('tell application "System Events"')) {
        systemEventsChecks++;
        return { code: 0, stdout: 'Finder', stderr: '' };
      }
      return { code: 0, stdout: 'true', stderr: '' };
    });
    assert.equal((await platform.checkPermissions(false, true)).find((check) => check.id === 'automation')!.ok, true);
    await assert.rejects(platform.launchAgent({ tool: 'codex', cwd, prompt: 'Explain tell application "System Events" without running it.' }), (error) =>
      error instanceof PermissionError && error.permission === 'automation' && /control Terminal/.test(error.message));
    assert.equal((await platform.checkPermissions()).find((check) => check.id === 'automation')!.ok, true,
      'denying Terminal does not revoke access to System Events');
    assert.equal(systemEventsChecks, 1, 'the passive check retains the verified result without requesting consent');
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
});

test('macOS shortcuts receive a five-minute timeout and a literal shortcut name', async () => {
  const calls: { cmd: string; args: string[]; timeout?: number }[] = [];
  const platform = new MacPlatform(async (cmd, args, timeout) => {
    calls.push({ cmd, args, timeout });
    return { code: 0, stdout: '', stderr: '' };
  });
  const name = 'Focus "quotes" $(literal); ☕';
  await platform.runShortcut(`  ${name}  `);
  assert.deepEqual(calls, [{ cmd: '/usr/bin/shortcuts', args: ['run', name], timeout: 300_000 }]);
});

test('dry run records agent intent without checking paths, opening Terminal or executing a CLI', async () => {
  const logs: string[] = [];
  const platform = new DryRunPlatform('macos', (message) => logs.push(message));
  await platform.launchAgent({ tool: 'claude', cwd: '/does-not-exist', prompt: 'fixture task' });
  assert.equal(logs.length, 1);
  assert.match(logs[0]!, /launch claude \(new\) in \/does-not-exist/);
});
