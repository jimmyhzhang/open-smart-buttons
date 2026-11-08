import { test } from 'node:test';
import assert from 'node:assert/strict';
import { delimiter } from 'node:path';
import { parseProbe, resetUserPathForTests, userEnv, userPathDirs } from '../src/engine/user-env.ts';

test('login-shell PATH probe ignores shell noise and needs both markers', () => {
  assert.deepEqual(parseProbe('starship warning\n__OSB_PATH_START__/opt/homebrew/bin:/usr/bin:relative__OSB_PATH_END__\n'), ['/opt/homebrew/bin', '/usr/bin']);
  assert.equal(parseProbe('__OSB_PATH_START__/usr/bin'), null);
  assert.equal(parseProbe('no markers'), null);
});

test('user environment keeps user tools reachable and app credentials out', async (t) => {
  const saved = { ...process.env };
  t.after(() => { process.env = saved; resetUserPathForTests(null); });
  resetUserPathForTests(['/probe/bin']);
  process.env.PATH = '/first/bin';
  process.env.ANTHROPIC_API_KEY = 'secret';
  process.env.OPEN_SMART_BUTTONS_LOCAL_ONLY = '1';
  process.env.OPEN_SMART_BUTTONS_DATA = '/private/app-data';
  process.env.OSB_SIGN_IDENTITY = 'app-build-setting';
  process.env.NODE_OPTIONS = '--inspect';
  process.env.MY_SCRIPT_VAR = 'kept';
  const env = await userEnv({ EXTRA: 'x' });
  const dirs = env.PATH!.split(delimiter);
  assert.deepEqual(dirs.slice(0, 2), ['/probe/bin', '/first/bin'], 'login-shell PATH first, like Terminal');
  assert.ok(dirs.includes('/probe/bin') && dirs.includes('/opt/homebrew/bin') && dirs.includes('/usr/bin'));
  assert.deepEqual(dirs, userPathDirs());
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.OPEN_SMART_BUTTONS_LOCAL_ONLY, undefined);
  assert.equal(env.OPEN_SMART_BUTTONS_DATA, undefined);
  assert.equal(env.OSB_SIGN_IDENTITY, undefined);
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.MY_SCRIPT_VAR, 'kept');
  assert.equal(env.EXTRA, 'x');
  assert.ok(env.HOME && env.USER && env.SHELL);
});

test('commands return when the shell exits, leave background jobs running, and use a POSIX shell', async () => {
  const { MacPlatform } = await import('../src/engine/platform.ts');
  const { commandShell } = await import('../src/engine/user-env.ts');
  assert.match(commandShell(), /\/(zsh|bash|sh)$/);
  const started = Date.now();
  const r = await new MacPlatform().run('sleep 3 & echo started', 10_000);
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), 'started');
  assert.ok(Date.now() - started < 2000, `waited ${Date.now() - started} ms for a background job`);
  const t = await new MacPlatform().run('sleep 5', 300);
  assert.equal(t.code, 124);
  assert.match(t.stderr, /Timed out/);
});

test('a failed login-shell probe is retried later instead of being kept', async (t) => {
  const { warmUserPath } = await import('../src/engine/user-env.ts');
  const saved = process.env.SHELL;
  t.after(() => { process.env.SHELL = saved; resetUserPathForTests(null); });
  resetUserPathForTests(null);
  process.env.SHELL = '/nonexistent/shell';
  assert.deepEqual(await warmUserPath(), []);
  process.env.SHELL = saved;
  assert.deepEqual(await warmUserPath(), [], 'retries wait a minute');
  resetUserPathForTests(null); // after the retry window
  assert.ok((await warmUserPath()).length > 0, 'a later probe succeeds');
});
