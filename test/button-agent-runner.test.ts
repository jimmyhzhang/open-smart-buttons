import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runButtonAgent } from '../src/engine/button-agent-runner.ts';
const result={title:'Focus',icon:'focus',color:'#123456',type:'util.counter',settingsJson:'{}',statesJson:'[]',script:'',summary:'Counts.'};
test('both CLI adapters exchange structured output through real subprocesses with literal stdin',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'agent-adapters-')), oldPath=process.env.PATH;
 try {
 for(const tool of ['codex','claude'] as const) writeFileSync(join(dir,tool),`#!${process.execPath}\nconst fs=require('node:fs');const args=process.argv.slice(2);let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{if(input!=='literal $() --prompt')process.exit(4);const result=${JSON.stringify(result)};if(args.includes('exec')){if(!args.includes('read-only')||!args.includes('--ignore-user-config'))process.exit(5);fs.writeFileSync(args[args.indexOf('-o')+1],JSON.stringify(result));}else{if(!args.includes('--safe-mode')||args[args.indexOf('--tools')+1]!=='')process.exit(6);console.log(JSON.stringify({structured_output:result,is_error:false}));}});`,{mode:0o700});
 process.env.PATH=dir;
 for(const tool of ['codex','claude'] as const) assert.deepEqual(await runButtonAgent(tool,'literal $() --prompt',dir,new AbortController().signal),result);
 writeFileSync(join(dir,'claude'),`#!${process.execPath}\nconsole.log(JSON.stringify({is_error:true,result:'OAuth session expired'}));process.exit(1);`,{mode:0o700});
 await assert.rejects(runButtonAgent('claude','literal $() --prompt',dir,new AbortController().signal),/OAuth session expired/);
 } finally {process.env.PATH=oldPath;rmSync(dir,{recursive:true,force:true});}
});
