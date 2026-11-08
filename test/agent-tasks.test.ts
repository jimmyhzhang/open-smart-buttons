import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentTasks } from '../src/engine/agent-tasks.ts';
import { runAgentTask } from '../src/engine/agent-task-runner.ts';
import { resetUserPathForTests } from '../src/engine/user-env.ts';
import type { AgentTask } from '../src/shared/agent-task.ts';

const settle = () => new Promise<void>(resolve => setImmediate(resolve));
const request = { deviceId: 'neo', actionId: 'review', title: 'Review', tool: 'codex' as const, cwd: '/project', prompt: '$review Do the review' };

test('repeated presses coalesce; cancellation wins over late success and a later press can run again', async () => {
  const pending: { signal: AbortSignal; resolve(value: string): void }[] = [];
  const events: AgentTask[] = [];
  const tasks = new AgentTasks(task => events.push(task), async (_input, signal) => new Promise(resolve => pending.push({ signal, resolve })));
  const first = tasks.start(request);
  assert.equal(tasks.start(request).id, first.id);
  assert.equal(pending.length, 1);
  tasks.cancel(first.id);
  assert.equal(pending[0]!.signal.aborted, true);
  pending[0]!.resolve('late response');
  await settle();
  assert.equal(tasks.list()[0]!.status, 'cancelled');
  assert.equal(tasks.list()[0]!.output, undefined);
  const next = tasks.start(request);
  assert.notEqual(next.id, first.id);
  pending[1]!.resolve('final response');
  await settle();
  assert.equal(tasks.list()[0]!.output, 'final response');
  assert.deepEqual(events.map(t => t.status), ['running', 'cancelled', 'running', 'completed']);
});

test('removal, disconnect and shutdown cancel only applicable running tasks', async () => {
  const signals: AbortSignal[] = [];
  const tasks = new AgentTasks(undefined, async (_input, signal) => { signals.push(signal); return new Promise(() => {}); });
  tasks.start(request);
  tasks.start({ ...request, actionId: 'kept' });
  tasks.start({ ...request, deviceId: 'other', actionId: 'other' });
  tasks.retain(new Set(['kept', 'other']));
  assert.deepEqual(signals.map(s => s.aborted), [true, false, false]);
  tasks.disconnect('neo');
  assert.deepEqual(signals.map(s => s.aborted), [true, true, false]);
  tasks.close();
  assert.deepEqual(signals.map(s => s.aborted), [true, true, true]);
});

test('errors reach the result, output/history stay bounded, and active tasks cannot be evicted', async () => {
  const tasks = new AgentTasks(undefined, async input => {
    if (input.prompt === 'fail') throw new Error('CLI sign-in expired');
    return 'x'.repeat(100_000);
  });
  tasks.start({ ...request, prompt: 'fail' });
  await settle();
  assert.equal(tasks.list()[0]!.status, 'failed');
  assert.match(tasks.list()[0]!.error!, /sign-in expired/);
  for (let i = 0; i < 25; i++) { tasks.start({ ...request, actionId: String(i) }); await settle(); }
  assert.equal(tasks.list().length, 20);
  assert.equal(tasks.list()[0]!.output!.length, 64 * 1024);
  const active = new AgentTasks(undefined, () => new Promise(() => {}));
  for (let i = 0; i < 20; i++) active.start({ ...request, actionId: String(i) });
  assert.throws(() => active.start({ ...request, actionId: 'overflow' }), /already running/);
  active.cancel(active.list()[0]!.id);
  assert.throws(() => active.start({ ...request, actionId: 'overflow' }), /already running/, 'a cancelled process is retained until it settles');
  active.close();
});

test('CLI runner forwards skills and shell metacharacters as stdin, keeps project cwd, and reports permission failures', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'osb-task-runner-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  resetUserPathForTests([bin]);
  t.after(() => { resetUserPathForTests(); rmSync(dir, { recursive: true, force: true }); });
  const fixture = `#!${process.execPath}
let input=''; for await (const c of process.stdin) input+=c;
const args=process.argv.slice(2);
if(input==='wait') { setInterval(()=>{},1000); }
else if(args[0]==='exec') {
  const fs=await import('node:fs');
  fs.writeFileSync(args[args.indexOf('--output-last-message')+1], JSON.stringify({input,args,cwd:process.cwd()}));
} else {
  console.log(JSON.stringify({result:JSON.stringify({input,args,cwd:process.cwd()}), permission_denials:input==='deny'?[{tool_name:'Bash'}]:[]}));
}
`;
  for (const tool of ['codex', 'claude']) writeFileSync(join(bin, tool), fixture, { mode: 0o755 });
  const marker = join(dir, 'injected');
  const prompt = `$review /review --model fake; $(touch ${marker})\nLiteral skill prompt`;
  for (const tool of ['codex', 'claude'] as const) {
    const result = JSON.parse(await runAgentTask({ tool, cwd: dir, prompt }, new AbortController().signal));
    assert.equal(result.input, prompt);
    assert.equal(result.cwd, realpathSync(dir));
    assert.equal(result.args.includes(prompt), false);
    assert.equal(result.args.some((arg: string) => /dangerously|safe-mode/.test(arg)), false);
    if (tool === 'codex') assert.equal(result.args[result.args.indexOf('--sandbox') + 1], 'workspace-write');
  }
  assert.equal(existsSync(marker), false);
  await assert.rejects(runAgentTask({ tool: 'claude', cwd: dir, prompt: 'deny' }, new AbortController().signal), /needs permission.*Terminal/);
  await assert.rejects(runAgentTask({ tool: 'codex', cwd: dir, prompt: '' }, new AbortController().signal), /Enter a prompt/);
  await assert.rejects(runAgentTask({ tool: 'codex', cwd: join(dir, 'missing'), prompt }, new AbortController().signal), /does not exist/);
  const controller = new AbortController();
  const running = runAgentTask({ tool: 'codex', cwd: dir, prompt: 'wait' }, controller.signal);
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(running, /Cancelled/);
});
