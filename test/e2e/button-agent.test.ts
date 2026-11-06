import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { WebSocket } from 'ws';
import { Store } from '../../src/engine/store.ts';
import type { ButtonProposal } from '../../src/shared/button-agent.ts';
const delay=(ms:number)=>new Promise(r=>setTimeout(r,ms));
test('real HTTP/WebSocket → bounded inference request → validated button; modify, cancel, undo and restart', {timeout:30000},async t=>{
 const dir=await mkdtemp(join(tmpdir(),'sdp-agent-e2e-'));
 const proposal: ButtonProposal = {
  title: 'Generated',
  icon: 'hash',
  color: '#123456',
  type: 'util.counter',
  settingsJson: '{}',
  statesJson: '[]',
  script: '',
  summary: 'Counts.',
 };
 const prompts: string[] = [];
 const provider = createHttpServer(async (req, res) => {
   const chunks = [];
   for await (const chunk of req) chunks.push(chunk);
   const input = JSON.parse(Buffer.concat(chunks).toString());
   const prompt = String(input.messages[0].content);
   prompts.push(prompt);
   const result = { ...proposal };
   if (prompt.includes('MODIFY_FIXTURE')) result.title = 'Modified';
   if (prompt.includes('SCRIPT_FAILURE_FIXTURE')) {
     result.type = 'system.script';
     result.script = '#!/bin/bash\nexit 9\n';
   }
   if (prompt.includes('REDIRECT_FIXTURE')) return void res.writeHead(302, { Location: 'http://127.0.0.1:1/' }).end();
   if (prompt.includes('SLOW_FIXTURE')) await delay(750);
   res.end(JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(result) }] }));
 });
 await new Promise<void>(r => provider.listen(0, '127.0.0.1', r));
 const inferencePort = (provider.address() as { port: number }).port;
 t.after(() => provider.close());
 const store=new Store(dir);store.config.settings.executeActions=false;store.config.settings.autoSimulator=false;store.flush();
 const lease=createServer();await new Promise<void>(r=>lease.listen(0,'127.0.0.1',r));const port=(lease.address() as {port:number}).port;await new Promise<void>(r=>lease.close(()=>r()));
 let child:ReturnType<typeof spawn>,ws:WebSocket;let seq=0;const pending=new Map<number,{resolve:(v:any)=>void;reject:(e:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
 let authorization = '';
 const start = async () => {
   child = spawn(process.execPath, ['--import', './test/e2e/mock-inference.mjs', 'src/server/main.ts', '--no-hid', '--port', String(port), '--data', dir], {
     env: { ...process.env, STREAMDECK_AI: 'api', STREAMDECK_LOCAL_ONLY: '1', ANTHROPIC_API_KEY: 'isolated-test-key', STREAMDECK_CLAUDE_MODEL: 'fixture-model', TEST_INFERENCE_PORT: String(inferencePort) },
     stdio: 'ignore',
   });
   const tokenFile = join(dir, `session-${port}.token`);
   for (let i = 0; i < 100; i++) {
     try { authorization = `Bearer ${await readFile(tokenFile, 'utf8')}`; break; } catch { await delay(30); }
   }
   ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { authorization } });
   ws.on('message', raw => {
     const m = JSON.parse(String(raw)), p = pending.get(m.id);
     if (p) { clearTimeout(p.timer); pending.delete(m.id); m.error ? p.reject(Error(m.error)) : p.resolve(m.result); }
   });
   await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
 };
 const stop=async()=>{ws?.terminate();if(child && child.exitCode===null){const exited=new Promise<void>(r=>child.once('exit',()=>r()));child.kill('SIGTERM');await exited;}};
 t.after(async()=>{await stop();for(const p of pending.values())clearTimeout(p.timer);await rm(dir,{recursive:true,force:true});});
 const rpc=(method:string,params:Record<string,unknown>={}):Promise<any>=>new Promise((resolve,reject)=>{const id=++seq,timer=setTimeout(()=>{pending.delete(id);reject(Error('RPC timeout'));},3000);pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params}));});
 const state=async()=>await (await fetch(`http://127.0.0.1:${port}/api/state`, { headers: { authorization } })).json() as any;
 const finish=async(id:string)=>{for(let i=0;i<150;i++){const j=(await rpc('buttonAgent.list')).find((j:any)=>j.id===id);if(!['creating','validating','repairing'].includes(j.status))return j;await delay(20);}throw Error('Job timeout');};
 await start();await rpc('sim.add',{modelId:'neo'});let s=await state();let dev=s.devices.find((d:any)=>d.modelId==='neo')||s.devices.at(-1);const target={profileId:dev.profileId,pageId:dev.pageId,kind:'key',index:4};
 const slot=async()=>{const s=await state();return s.config.profiles.find((p:any)=>p.id===target.profileId).pages[target.pageId].keys[4];};
 const original=await slot();
 await t.test('provider preference validates and persists',async()=>{await assert.rejects(rpc('settings.update',{patch:{buttonAgent:{enabled:true,provider:'bad'}}}),/Choose/);await rpc('settings.update',{patch:{buttonAgent:{enabled:true,provider:'claude'}}});});
 await t.test('create and modify publish complete settings and icons',async()=>{let j=await rpc('buttonAgent.start',{target,instruction:'Create counter',provider:'api'});assert.equal((await finish(j.id)).status,'ready');assert.equal((await slot()).appearance.icon.name,'hash');await rpc('buttonAgent.test',{id:j.id,deviceId:dev.id});j=await rpc('buttonAgent.start',{target,instruction:'MODIFY_FIXTURE',provider:'api'});assert.equal((await finish(j.id)).status,'ready');assert.equal((await slot()).appearance.title,'Modified');await rpc('buttonAgent.undo',{id:j.id});assert.equal((await slot()).appearance.title,'Generated');});
 await t.test('cancel rejects overlapping jobs and prevents late assignment',async()=>{const before=await slot();const j=await rpc('buttonAgent.start',{target,instruction:'SLOW_FIXTURE',provider:'api'});await assert.rejects(rpc('buttonAgent.start',{target,instruction:'Other',provider:'api'}),/current creation/);await rpc('buttonAgent.cancel',{id:j.id});assert.equal((await finish(j.id)).status,'cancelled');await delay(100);assert.deepEqual(await slot(),before);});
 await t.test('restart retains provider, job outcome and saved button',async()=>{await stop();await start();assert.equal((await state()).config.settings.buttonAgent.provider,'claude');assert.equal((await rpc('buttonAgent.list')).at(-1).status,'cancelled');assert.equal((await slot()).appearance.title,'Generated');assert.notDeepEqual(await slot(),original);});
 await t.test('USB is isolated; strict mode blocks scripts and redirects', async () => {
   await rpc('devices.scan');
   assert.ok((await state()).discovered.every((d: any) => d.kind === 'sim'));
   await assert.rejects(rpc('devices.connect', { path: 'fixture-device' }), /USB is disabled/);
   const before = await slot();
   for (const [instruction, message] of [
     ['SCRIPT_FAILURE_FIXTURE', /local-only/],
     ['REDIRECT_FIXTURE', /HTTP 302/],
   ] as const) {
     const j = await rpc('buttonAgent.start', { target, instruction, provider: 'api' });
     const completed = await finish(j.id);
     assert.equal(completed.status, 'failed');
     assert.match(completed.error, message);
     assert.deepEqual(await slot(), before);
   }
   assert.ok(prompts.length > 0);
   assert.ok(prompts.every(prompt => !prompt.includes('REUSABLE SCRIPTS')));
   await rpc('buttonAgent.clearHistory');
   assert.deepEqual(await rpc('buttonAgent.list'), []);
   assert.deepEqual(await slot(), before);
 });
});
