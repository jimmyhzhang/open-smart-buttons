import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/engine/store.ts';
import { Engine } from '../src/engine/engine.ts';
import { DeviceManager } from '../src/device/manager.ts';
import { ButtonAgent } from '../src/engine/button-agent.ts';
import { boundedProcess, type ButtonRunner } from '../src/engine/button-agent-runner.ts';
import type { ButtonProposal } from '../src/shared/button-agent.ts';
const proposal:ButtonProposal={title:'Count',icon:'hash',color:'#123456',type:'util.counter',settingsJson:'{}',statesJson:'[]',script:'',summary:'Press to count.'};
const tick=()=>new Promise(r=>setTimeout(r,10));
async function boot(t:any,runner:ButtonRunner) {const dir=mkdtempSync(join(tmpdir(),'button-agent-test-'));const store=new Store(dir);store.config.settings.executeActions=false;const manager=new DeviceManager();const engine=new Engine(store,manager);const dev=await manager.addSimulator('neo',{pageLatencyMs:0});const session=engine.sessions.get(dev.id)!;const target={profileId:session.profileId,pageId:session.pageId,kind:'key' as const,index:4};const service=new ButtonAgent(engine,runner);t.after(async()=>{service.close();await manager.stop();store.flush();rmSync(dir,{recursive:true,force:true});});return {service,engine,store,target,session,dir};}
async function done(service:ButtonAgent,id:string) {for(let i=0;i<400;i++){const j=service.list().find(j=>j.id===id)!;if(!['creating','validating','repairing'].includes(j.status))return j;await tick();}throw Error('job did not finish');}
test('create → install → real simulator press → undo restores exact previous button',async t=>{const {service,engine,target,session}=await boot(t,async()=>proposal);const slots=engine.store.profile(target.profileId)!.pages[target.pageId]!.keys;const before=structuredClone(slots[4]);const job=service.start(target,'Count things','codex');assert.equal((await done(service,job.id)).status,'ready');session.handleKey(4,true);session.handleKey(4,false);assert.equal(engine.stateFor(slots[4]!.id).n,1);service.undo(job.id);assert.deepEqual(slots[4],before);});
test('invalid icon automatically repairs once, second invalid result never changes target',async t=>{let n=0;const {service,target,store}=await boot(t,async()=>{n++;return {...proposal,icon:n===1?'not-a-real-icon':'hash'};});assert.equal((await done(service,service.start(target,'Count','claude').id)).status,'ready');assert.equal(n,2);const bad=new ButtonAgent(new Engine(store,new DeviceManager()),async()=>({...proposal,icon:'not-real'}));const before=JSON.stringify(store.config);assert.equal((await done(bad,bad.start(target,'Count','codex').id)).status,'failed');assert.equal(JSON.stringify(store.config),before);});
test('cancel and overlapping starts cannot install a late successful result',async t=>{let resolve!:(p:ButtonProposal)=>void;const {service,target,store}=await boot(t,()=>new Promise(r=>resolve=r));const before=JSON.stringify(store.config);const job=service.start(target,'Count','codex');assert.throws(()=>service.start(target,'Second','codex'),/current creation/);service.cancel(job.id);resolve(proposal);await tick();assert.equal((await done(service,job.id)).status,'cancelled');assert.equal(JSON.stringify(store.config),before);});
test('same-ID concurrent settings edit is protected; undo also detects later appearance edits',async t=>{let resolve!:(p:ButtonProposal)=>void;const {service,target,store}=await boot(t,()=>new Promise(r=>resolve=r));const slots=store.profile(target.profileId)!.pages[target.pageId]!.keys;const job=service.start(target,'Count','codex');slots[4]!.appearance.title='Keep my edit';resolve(proposal);assert.equal((await done(service,job.id)).status,'failed');assert.equal(slots[4]!.appearance.title,'Keep my edit');const job2=service.start(target,'Count','codex');resolve(proposal);assert.equal((await done(service,job2.id)).status,'ready');slots[4]!.appearance.title='Later edit';assert.throws(()=>service.undo(job2.id),/overwrite/);});
test('generated script syntax is checked, invalid script repairs, content is reused, and never runs during creation',async t=>{let n=0;const script='#!/bin/bash\nprintf "ready\\n"\n';const {service,target,store,dir}=await boot(t,async()=>({...proposal,type:'system.script',settingsJson:'{}',script:++n===1?'#!/bin/bash\nif then\n':script}));const job=await done(service,service.start(target,'Make a script','codex').id);assert.equal(job.status,'ready');assert.equal(n,2);const path=String(store.profile(target.profileId)!.pages[target.pageId]!.keys[4]!.settings.path);assert.equal(readFileSync(path,'utf8'),script);assert.ok(path.startsWith(dir));assert.equal(await boundedProcess('/bin/bash',[path],dir,'',new AbortController().signal,1000),'ready\n');const next=await done(service,service.start(target,'Same script','codex').id);assert.equal(next.status,'ready');assert.equal(store.profile(target.profileId)!.pages[target.pageId]!.keys[4]!.settings.path,path);});
test('process timeout, abort, nonzero exit and literal stdin are observable failures',async()=>{const dir=tmpdir();const signal=new AbortController();assert.equal(await boundedProcess('/bin/cat',[],dir,'$(touch DO_NOT_RUN)',signal.signal,1000),'$(touch DO_NOT_RUN)');await assert.rejects(boundedProcess('/bin/sh',['-c','sleep 10'],dir,'',signal.signal,30),/timed out/);await assert.rejects(boundedProcess('/bin/sh',['-c','echo failed >&2; exit 3'],dir,'',signal.signal,1000),/failed/);const abort=new AbortController();const running=boundedProcess('/bin/sh',['-c','sleep 10'],dir,'',abort.signal,1000);abort.abort();await assert.rejects(running,/Cancelled/);});
test('restart preserves successful jobs and marks in-flight work interrupted',async t=>{const {service,engine,target}=await boot(t,async()=>proposal);const ready=service.start(target,'Count','codex');await done(service,ready.id);const reopened=new ButtonAgent(engine,()=>new Promise(()=>{}));assert.equal(reopened.list().at(-1)?.status,'ready');reopened.start(target,'Pending','codex');const restarted=new ButtonAgent(engine,async()=>proposal);assert.equal(restarted.list().at(-1)?.status,'interrupted');reopened.close();});

test('essential missing details produce a question without changing the button',async t=>{const {service,target,store}=await boot(t,async()=>({...proposal,type:'needs-input',summary:'Which project folder should open?'}));const before=JSON.stringify(store.config);const j=await done(service,service.start(target,'Open my project','codex').id);assert.equal(j.status,'needs-input');assert.match(j.summary!,/Which project/);assert.equal(JSON.stringify(store.config),before);});
test('Try button refuses a different page or a modified target',async t=>{const {service,target,session,store}=await boot(t,async()=>proposal);const j=await done(service,service.start(target,'Count','codex').id);session.setPage(store.profile(target.profileId)!.pageOrder[1]!);assert.throws(()=>service.test(j.id,session.dev.id),/original unchanged/);session.setPage(target.pageId);store.profile(target.profileId)!.pages[target.pageId]!.keys[4]!.appearance.title='Changed';assert.throws(()=>service.test(j.id,session.dev.id),/original unchanged/);});

test('folder targets, invalid positions, and unsupported providers are rejected before spawning',async t=>{let calls=0;const {service,target}=await boot(t,async()=>{calls++;return proposal;});assert.throws(()=>service.start({...target,index:3},'Replace','codex'),/preserves folders/);assert.throws(()=>service.start({...target,index:-1},'Replace','codex'),/target button/);assert.throws(()=>service.start(target,'','codex'),/Describe/);assert.throws(()=>service.start(target,'Replace','invalid' as any),/Choose/);assert.equal(calls,0);});

test('modified external script source is included and an explicitly requested bash script can be reused',async t=>{
 let prompt='';const {service,target,store,dir}=await boot(t,async(_provider,text)=>{prompt=text;return {...proposal,type:'system.script',settingsJson:JSON.stringify({path:join(dir,'existing.sh')}),script:''};});
 const {writeFileSync}=await import('node:fs');writeFileSync(join(dir,'existing.sh'),'#!/bin/bash\nprintf "existing\\n"\n',{mode:0o700});
 const result=await done(service,service.start(target,`Reuse ${join(dir,'existing.sh')}`,'codex').id);assert.equal(result.status,'ready');
 const next=await done(service,service.start(target,'Keep my existing script','codex').id);assert.equal(next.status,'ready');assert.match(prompt,/SELECTED SCRIPT SOURCE/);assert.ok(prompt.includes('existing\\\\n'));assert.equal(store.profile(target.profileId)!.pages[target.pageId]!.keys[4]!.settings.path,join(dir,'existing.sh'));
});

test('dry-run blocks script tests without creating output or recording success', async t => {
  const { service, target, session, dir } = await boot(t, async () => ({ ...proposal, type: 'system.script', script: '#!/bin/bash\nprintf should-not-run\n' }));
  const job = await done(service, service.start(target, 'Script', 'codex').id);
  assert.throws(() => service.test(job.id, session.dev.id), /Actions are off/);
  assert.equal(service.list().at(-1)?.lastRun?.status, 'blocked');
  assert.equal(service.list().at(-1)?.lastRun?.output, undefined);
});

test('real script test awaits completion, returns output, prevents concurrent edits and persists failure', async t => {
  let fail = false;
  const { service, engine, target, session, dir } = await boot(t, async () => ({ ...proposal, type: 'system.script', script: fail
    ? '#!/bin/bash\nprintf "Screen Recording permission denied" >&2\nexit 7\n'
    : '#!/bin/bash\nsleep 0.15\nprintf "Saved output.png\\n"\n' }));
  engine.setExecute(true);
  const job = await done(service, service.start(target, 'Script', 'codex').id);
  const run = service.test(job.id, session.dev.id);
  assert.equal(service.list().at(-1)?.lastRun?.status, 'running');
  assert.throws(() => service.test(job.id, session.dev.id), /already running/);
  assert.throws(() => service.undo(job.id), /running action/);
  assert.throws(() => service.start(target, 'Change', 'codex'), /running button/);
  const result = await run;
  assert.equal(result?.status, 'completed');
  assert.equal(result?.output, 'Saved output.png');
  fail = true;
  const bad = await done(service, service.start(target, 'Fail', 'codex').id);
  await assert.rejects(service.test(bad.id, session.dev.id), /Script exited 7: Screen Recording permission denied/);
  const reopened = new ButtonAgent(engine, async () => proposal);
  assert.equal(reopened.list().at(-1)?.lastRun?.status, 'failed');
  assert.match(reopened.list().at(-1)!.lastRun!.message, /permission denied/);
});

test('a stale edit does not start an agent job against a different action', async t => {
  let launches = 0;
  const { service, target } = await boot(t, async () => { launches++; return proposal; });
  assert.throws(() => service.start(target, 'Replace', 'claude', 'outdated-action'), /key changed/);
  assert.equal(launches, 0);
  assert.deepEqual(service.list(), []);
});
test('the agent can design state rules: names become icon references, bad rules repair once, and the prompt explains sources',async t=>{let n=0,prompt='';const rules=[{source:'muted',op:'is',value:true,icon:'volume-x'},{source:'volume',op:'<=',value:0,icon:'volume-x',bg:'#3b0d0d'}];const {service,target,store}=await boot(t,async(_p,text)=>{prompt=text;n++;return {...proposal,title:'Vol Down',icon:'volume-1',type:'system.volume',settingsJson:'{"mode":"down"}',statesJson:JSON.stringify(n===1?[{source:'volume',op:'contains',value:'0',icon:'volume-x'}]:rules)};});const job=await done(service,service.start(target,'Show a muted icon while the Mac is silent','codex').id);assert.equal(job.status,'ready');assert.equal(n,2);assert.match(prompt,/STATE SOURCES: .*"appRunning"/);assert.match(prompt,/failed validation: State rules: Rule 1/);const key=store.profile(target.profileId)!.pages[target.pageId]!.keys[4]!;assert.deepEqual(key.stateRules,[{source:'muted',op:'is',value:true,icon:{kind:'lucide',name:'volume-x'}},{source:'volume',op:'<=',value:0,icon:{kind:'lucide',name:'volume-x'},bg:'#3b0d0d'}]);assert.ok(job.checks!.some(c=>/2 state rules validated/.test(c)));});
test('an unknown state rule icon is rejected and leaves the button unchanged',async t=>{const {service,target,store}=await boot(t,async()=>({...proposal,statesJson:'[{"source":"darkMode","op":"is","value":true,"icon":"not-a-real-icon"}]'}));const before=JSON.stringify(store.config);const job=await done(service,service.start(target,'Moon at night','codex').id);assert.equal(job.status,'failed');assert.match(job.error!,/State rule 1: choose an existing Lucide icon/);assert.equal(JSON.stringify(store.config),before);});

test('a failed profile flush leaves the original button in place', async t => {
  const { service, store, target } = await boot(t, async () => proposal);
  const original = structuredClone(store.profile(target.profileId)!.pages[target.pageId]!.keys[target.index]);
  const flush = store.flush.bind(store);
  let fail = true;
  store.flush = () => {
    if (fail) {
      fail = false;
      throw new Error('fixture disk write failed');
    }
    flush();
  };
  const job = service.start(target, 'Create a counter', 'claude');
  const finished = await done(service, job.id);
  assert.equal(finished.status, 'failed');
  assert.match(finished.error ?? '', /fixture disk write failed/);
  assert.deepEqual(store.profile(target.profileId)!.pages[target.pageId]!.keys[target.index], original);
});

test('a malformed journal is preserved and a new agent job still works', async t => {
  const { engine, target, service } = await boot(t, async () => proposal);
  mkdirSync(service.dir);
  writeFileSync(join(service.dir, 'jobs.json'), '[null]');
  const recovered = new ButtonAgent(engine, async () => proposal);
  assert.deepEqual(recovered.list(), []);
  const backup = readdirSync(service.dir).find(name => name.startsWith('jobs.recovery-'))!;
  assert.equal(readFileSync(join(service.dir, backup), 'utf8'), '[null]');
  assert.equal((await done(recovered, recovered.start(target, 'Create counter', 'claude').id)).status, 'ready');
});

test('failure to create the initial journal record does not register a running job', async t => {
  let calls = 0;
  const { service, target } = await boot(t, async () => { calls++; return proposal; });
  mkdirSync(join(service.dir, 'jobs.json.tmp'), { recursive: true });
  assert.throws(() => service.start(target, 'Create counter', 'claude'), /EISDIR/);
  assert.equal(calls, 0);
  assert.deepEqual(service.list(), []);
  rmSync(join(service.dir, 'jobs.json.tmp'), { recursive: true });
  assert.equal((await done(service, service.start(target, 'Retry counter', 'claude').id)).status, 'ready');
  assert.equal(calls, 1);
});
