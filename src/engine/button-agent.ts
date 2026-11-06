import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { ACTION_MAP, CATALOG, newInstance } from './actions.ts';
import { validateActionSetup } from '../shared/action-setup.ts';
import { agentWorkingDirectory } from './agent-launcher.ts';
import { buildScriptCommand } from './script-commands.ts';
import { boundedProcess, runButtonAgent, type ButtonRunner } from './button-agent-runner.ts';
import { activeButtonJob, type ButtonJob, type ButtonProposal, type ButtonTarget, type ButtonAgentProvider } from '../shared/button-agent.ts';
import type { ActionInstance } from '../shared/types.ts';
import { STATE_OPS, STATE_SOURCES, validateStateRules, type StateRule } from '../shared/state-rules.ts';
import type { Engine, Session } from './engine.ts';
import { canConfigureLocalAction, isLocalAction, externalActionMessage } from '../shared/local-action-policy.ts';
import { assertProfile } from '../shared/profile-validation.ts';
const iconsDir = join(dirname(createRequire(import.meta.url).resolve('lucide-static/package.json')), 'icons');
const stateSources = STATE_SOURCES.map(({ id, label, kind, unit, arg }) => ({ source: id, label, kind, unit, needsArg: arg?.label, ops: STATE_OPS[kind].map(o => o.value) }));
const allowed = CATALOG.filter(m => m.controllers.includes('key') && m.category !== 'Hidden' && !['sd.folder','sd.multi','system.command','util.toggle'].includes(m.type));
interface SavedJob extends ButtonJob { before: ActionInstance | null; after?: ActionInstance }
const jobStatuses = new Set(['creating', 'validating', 'repairing', 'ready', 'failed', 'cancelled', 'interrupted', 'undone', 'needs-input']);

function isSavedJob(value: unknown): value is SavedJob {
  if (!value || typeof value !== 'object') return false;
  const job = value as Partial<SavedJob>;
  const target = job.target;
  return typeof job.id === 'string' && typeof job.instruction === 'string' &&
    typeof job.status === 'string' && jobStatuses.has(job.status) &&
    (job.provider === 'claude' || job.provider === 'codex') &&
    typeof job.startedAt === 'number' && typeof job.updatedAt === 'number' &&
    !!target && typeof target.profileId === 'string' && typeof target.pageId === 'string' &&
    (target.kind === 'key' || target.kind === 'dial') && Number.isInteger(target.index) && target.index >= 0 &&
    (job.before === null || !!job.before && typeof job.before === 'object') &&
    (job.after === undefined || !!job.after && typeof job.after === 'object');
}

export class ButtonAgent {
  readonly dir: string;
  private jobs: SavedJob[] = [];
  private running = new Map<string, AbortController>();
  private engine: Engine;
  private runner: ButtonRunner;
  private journalBlocked = false;
  constructor(engine: Engine, runner: ButtonRunner = runButtonAgent) {
    this.engine = engine; this.runner = runner; this.dir = join(engine.store.dir, 'button-agent');
    const path = join(this.dir, 'jobs.json');
    try {
      const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
      if (!Array.isArray(value) || value.length > 20 || !value.every(isSavedJob)) throw new Error('Invalid design history');
      this.jobs = value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        try {
          renameSync(path, join(this.dir, `jobs.recovery-${randomUUID()}.json`));
          this.engine.log('warn', 'Unreadable AI design history was preserved in the data directory.');
        } catch {
          this.journalBlocked = true;
          this.engine.log('warn', 'AI design history could not be opened or preserved. Button editing is still available.');
        }
      }
    }
    for (const job of this.jobs) {
      if (job.lastRun?.status === 'running') {
        job.lastRun = { status: 'failed', at: Date.now(), message: 'The app restarted during the test. Its outcome is unknown.' };
      }
      if (activeButtonJob(job.status)) {
        let applied = false;
        try { applied = !!job.after && JSON.stringify(this.slot(job.target)[job.target.index]) === JSON.stringify(job.after); } catch {}
        job.status = applied ? 'ready' : 'interrupted';
        if (!applied) job.error = 'The app restarted before this creation completed. Check the selected button and try again.';
      }
    }
  }
  list(): ButtonJob[] {
    return this.jobs.map(({ before, after, ...job }) => {
      if (job.status !== 'ready') return job;
      try {
        return { ...job, applied: !!after && JSON.stringify(this.slot(job.target)[job.target.index]) === JSON.stringify(after) };
      } catch {
        return { ...job, applied: false };
      }
    });
  }
  clearHistory(): void {
    if (this.running.size || this.jobs.some(job => job.lastRun?.status === 'running')) {
      throw new Error('Wait for the current design or run before clearing history.');
    }
    this.persist([]);
    this.jobs = [];
  }
  private persist(jobs: SavedJob[]) {
    if (this.journalBlocked) throw new Error('Preserve or repair the unreadable AI design history and restart the app.');
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const path = join(this.dir, 'jobs.json');
    writeFileSync(path + '.tmp', JSON.stringify(jobs), { mode: 0o600, flush: true });
    renameSync(path + '.tmp', path);
  }
  private update(job: SavedJob, patch: Partial<ButtonJob>) {
    const next = { ...job, ...patch, updatedAt: Date.now() };
    this.persist(this.jobs.map((entry) => entry === job ? next : entry));
    Object.assign(job, next);
  }
  private settle(job: SavedJob, patch: Partial<ButtonJob>) {
    try { this.update(job, patch); }
    catch (error) {
      Object.assign(job, patch, { updatedAt: Date.now() });
      this.engine.log('warn', `Could not save AI design history: ${(error as Error).message}`);
    }
  }
  private slot(t: ButtonTarget) {
    if (!['key','dial'].includes(t.kind) || !Number.isInteger(t.index)) throw new Error('Select a button first');
    const page = this.engine.store.profile(t.profileId)?.pages[t.pageId];
    const slots = page && (t.kind === 'key' ? page.keys : page.dials);
    if (!slots || t.index < 0 || t.index >= slots.length) throw new Error('The target button no longer exists');
    return slots;
  }
  start(target: ButtonTarget, instruction: string, provider: ButtonAgentProvider, expectedActionId?: string | null): ButtonJob {
    if (this.running.size) throw new Error('Finish or cancel the current creation first');
    if (this.jobs.some(j=>j.lastRun?.status==='running')) throw new Error('Wait for the running button before changing it.');
    if (!['codex','claude'].includes(provider)) throw new Error('Choose Codex or Claude Code');
    if (typeof instruction !== 'string' || !instruction.trim() || instruction.length > 6000) throw new Error('Describe the button in 1–6000 characters');
    const before = structuredClone(this.slot(target)[target.index] ?? null);
    if (expectedActionId !== undefined && (before?.id ?? null) !== expectedActionId) {
      throw new Error('This key changed while you were editing. Select it again before updating it.');
    }
    if (before?.type === 'sd.folder') throw new Error('Select a regular button; automatic setup preserves folders and their contents');
    const job: SavedJob = { id:randomUUID(),target:structuredClone(target),instruction:instruction.trim(),provider,status:'creating',startedAt:Date.now(),updatedAt:Date.now(),before };
    const jobs = [...this.jobs.slice(-19), job];
    this.persist(jobs);
    this.jobs = jobs;
    const controller = new AbortController();
    this.running.set(job.id, controller);
    void this.run(job,controller);
    return this.list().at(-1)!;
  }
  cancel(id: string) {
    const job = this.jobs.find(j => j.id === id);
    if (!job || !activeButtonJob(job.status)) return;
    this.running.get(id)?.abort();
    this.settle(job, { status: 'cancelled' });
  }
  close() { for (const id of this.running.keys()) this.cancel(id); }
  test(id: string, deviceId: string) {
    const job=this.jobs.find(j=>j.id===id), session=this.engine.sessions.get(deviceId);
    if (!job || job.status!=='ready' || !session || session.profileId!==job.target.profileId || session.pageId!==job.target.pageId || JSON.stringify(this.slot(job.target)[job.target.index])!==JSON.stringify(job.after)) throw new Error('Select the original unchanged button before trying it.');
    if (job.lastRun?.status==='running') throw new Error('This button is already running.');
    if (!session.platform.canExecute && /^(system\.|agent\.)/.test(job.after!.type)) {
      const message = this.engine.localOnly && session.dev.kind === 'sim'
        ? 'Mac actions are off for simulated decks. Connect a USB deck to run this button on the Mac.'
        : 'Actions are off. Enable “Perform actions on this computer” before running this button. Nothing was executed.';
      this.update(job,{lastRun:{status:'blocked',at:Date.now(),message}});
      throw new Error(message);
    }
    return this.runTest(job, session);
  }
  private async runTest(job: SavedJob, session: Session) {
    this.update(job,{lastRun:{status:'running',at:Date.now(),message:'Running the button on this computer…'}});
    try {
      await this.engine.testAction(session.dev.id,job.target.kind,job.target.index);
      const output=job.after?.type==='system.script' ? String(this.engine.stateFor(job.after.id, session.dev).lastScriptOutput || '') : undefined;
      this.settle(job,{lastRun:{status:'completed',at:Date.now(),message:'Action finished without an execution error.',output}});
    } catch(error) {
      this.settle(job,{lastRun:{status:'failed',at:Date.now(),message:(error as Error).message}});
      throw error;
    }
    return job.lastRun;
  }
  undo(id: string) {
    const job = this.jobs.find(j=>j.id===id); if (!job || job.status !== 'ready') throw new Error('This result cannot be undone');
    if (job.lastRun?.status==='running') throw new Error('Wait for the running action before undoing it.');
    const slots=this.slot(job.target);
    if (JSON.stringify(slots[job.target.index]) !== JSON.stringify(job.after)) throw new Error('This button changed since creation. Undo would overwrite your edits.');
    this.install(job, slots, structuredClone(job.before));
    this.settle(job,{status:'undone'});
  }
  private install(job: SavedJob, slots: (ActionInstance | null)[], next: ActionInstance | null) {
    const previous = slots[job.target.index] ?? null;
    slots[job.target.index] = next;
    try {
      assertProfile(this.engine.store.profile(job.target.profileId));
      this.engine.store.flush();
    }
    catch (error) {
      slots[job.target.index] = previous;
      this.engine.store.save();
      throw error;
    }
    this.engine.configChanged(false);
  }
  private prompt(job: SavedJob): string {
    if (this.engine.localOnly) {
      const fields = job.before && ACTION_MAP.get(job.before.type)?.meta.fields;
      const existing = job.before && isLocalAction(job.before) ? {
        type: job.before.type,
        settings: Object.fromEntries((fields ?? []).map(({ key }) => [key, job.before!.settings[key]])),
        stateRules: job.before.stateRules,
        appearance: { title: job.before.appearance.title, icon: job.before.appearance.icon },
      } : null;
      return [
        'Design one macOS Stream Deck button using the supplied catalog. Return the required JSON object.',
        'Use only built-in local actions. Return script as an empty string. Never request or include secrets.',
        'Use a concise title, a Lucide icon name, a six-digit dark hex color, and a brief summary.',
        'settingsJson is a JSON object encoded as text. statesJson is a JSON array encoded as text.',
        'State rules use {source, op, value, arg?, icon?, bg?, title?}. First matching rule wins. Preserve existing rules when editing unrelated behavior.',
        'For a volume key use system.volume mode down, up, or mute. Set mutedIconWhenSilent for a muted icon at zero volume.',
        'If the request needs clarification or cannot be handled with the catalog, return type needs-input and explain in summary.',
        `Catalog: ${JSON.stringify(allowed.filter((action) => canConfigureLocalAction(action.type)))}`,
        `State sources: ${JSON.stringify(stateSources)}`,
        `Selected control: ${job.target.kind} ${job.target.index + 1}`,
        `Existing action: ${JSON.stringify(existing)}`,
        `Request: ${job.instruction}`,
      ].join('\n');
    }
    const scripts = readdirSync(this.dir).filter(f=>/^[a-f0-9]{64}\.sh$/.test(f)).slice(-12).map(f=>({path:join(this.dir,f),source:readFileSync(join(this.dir,f),'utf8').slice(0,12000)}));
    let selectedScript='';
    const selectedPath=job.before?.type==='system.script' ? job.before.settings.path : undefined;
    if(typeof selectedPath==='string' && existsSync(selectedPath) && statSync(selectedPath).isFile() && statSync(selectedPath).size<=50000) selectedScript=readFileSync(selectedPath,'utf8');
    return `You design macOS Stream Deck buttons. Return only the requested JSON object. Do not run commands or change files. Prefer a built-in action. For volume keys with a muted icon at zero volume, choose system.volume with mutedIconWhenSilent set to true and mode set to down, up, or mute as requested. The proposed icon is the normal icon. Keep the existing normal icon, title and background when only changing volume behavior. A button can also change its look while the computer is in a given state. statesJson is a JSON array of state rules, checked in order; the first match wins and the normal look returns when none matches. Each rule is {"source","op","value"} plus "arg" only when the source needs one (the app's name or its .app file name without .app, e.g. zoom.us for Zoom; case doesn't matter), and at least one of "icon" (Lucide name), "bg" (dark #RRGGBB) or "title" (at most 40 characters). value is a number, true/false or text to match the source's kind. Rules only change this button's look and never run anything, so use them, not scripts, for requests like "show X while Y". statesJson is the complete list this button should have: copy the existing button's stateRules to keep them, or [] for none. To change only how a button looks in a state, keep its type and settings. Reuse a supplied script when appropriate; otherwise generate a complete bash script with #!/bin/bash. Scripts run only when the user presses the button. Never invent paths, credentials or installed software. If essential information is missing, return type=needs-input with a short specific question in summary; leave settingsJson as {}, statesJson as [] and script empty. Validate your logic and edge cases before responding. Generated scripts must check command exit codes, report actionable failures to stderr, and exit nonzero on failure. For file-producing actions, verify each expected file exists and is nonempty before printing its absolute path to stdout. For screenshots use /usr/sbin/screencapture -x, verify the saved PNG with /usr/bin/sips, and report Screen Recording permission failures clearly. Do not claim runtime success from syntax checks. Never suppress failures with a success exit code. Choose a real Lucide icon name and a dark #RRGGBB background. Use a short 1–2 word title, ideally at most 14 characters (hard limit 40). settingsJson is JSON encoding an object matching the action metadata. script is empty for built-ins/reused scripts, or the bash source for system.script (the host supplies its path). summary briefly explains what pressing the button does. Do not place secrets in scripts/settings.\nCATALOG: ${JSON.stringify(allowed)}\nSTATE SOURCES: ${JSON.stringify(stateSources)}\nEXISTING BUTTON: ${JSON.stringify(job.before)}\nSELECTED SCRIPT SOURCE: ${JSON.stringify(selectedScript)}\nREUSABLE SCRIPTS: ${JSON.stringify(scripts)}\nSELECTED BUTTON: ${job.target.kind === 'key' ? 'Key' : 'Dial'} ${job.target.index + 1}. You can only change this button. If the instruction is about a different key or dial, return type=needs-input asking the user to select that one first.\nUSER INSTRUCTION: ${job.instruction}`;
  }
  private async prepare(p: ButtonProposal, job: SavedJob, signal: AbortSignal): Promise<ActionInstance> {
    for (const field of ['title','icon','color','type','settingsJson','statesJson','script','summary'] as const) if (typeof p?.[field] !== 'string') throw new Error(`Missing ${field} in agent result`);
    if (!p.title.trim()) throw new Error(p.summary.trim() ? `The agent did not design a button: ${p.summary.trim().slice(0, 300)}` : 'The agent returned no button title');
    if (p.title.length > 40) throw new Error('The agent chose a title longer than 40 characters');
    if (p.summary.length > 1500 || p.script.length > 50000 || p.settingsJson.length > 20000 || p.statesJson.length > 20000) throw new Error('The agent result was too large');
    if (!/^[a-z0-9-]+$/.test(p.icon) || !existsSync(join(iconsDir,p.icon+'.svg'))) throw new Error('Choose an existing Lucide icon');
    if (!/^#[a-f0-9]{6}$/i.test(p.color)) throw new Error('Choose a six-digit hex color');
    if (!allowed.some(m=>m.type===p.type)) throw new Error('Choose a supported action type');
    const settings = JSON.parse(p.settingsJson);
    if (!settings || typeof settings!=='object' || Array.isArray(settings)) throw new Error('Settings must be an object');
    if (this.engine.localOnly && (p.script || !isLocalAction({ type: p.type, settings: { ...ACTION_MAP.get(p.type)!.meta.defaults, ...settings } }))) {
      throw new Error(externalActionMessage);
    }
    if (p.script) {
      if (p.type!=='system.script' || !p.script.startsWith('#!/bin/bash\n') || p.script.includes('\0')) throw new Error('Generated scripts must be bash scripts');
      const path=join(this.dir,createHash('sha256').update(p.script).digest('hex')+'.sh');
      // Validate syntax without executing the proposed operation.
      await boundedProcess('/bin/bash',['-n'],this.dir,p.script,signal,5000);
      if (signal.aborted) throw new Error('Cancelled');
      writeFileSync(path,p.script,{mode:0o700}); settings.path=path;
    }
    if (p.type==='system.script') {
      const path=String(settings.path ?? '');
      const originalPath=job.before?.type==='system.script' ? job.before.settings.path : undefined;
      if (path!==originalPath && !(path.length>1 && job.instruction.includes(path)) && !(dirname(path)===this.dir && /^[a-f0-9]{64}\.sh$/.test(path.slice(this.dir.length+1)))) throw new Error('Reuse a supplied script or generate a new one');
      await buildScriptCommand({path,args:[settings.arg1??'',settings.arg2??'',settings.arg3??'']});
      await boundedProcess('/bin/bash',['-n',path],this.dir,'',signal,5000);
    }
    const inst=newInstance(p.type,randomUUID()); inst.settings={...inst.settings,...settings};
    const errors=validateActionSetup(ACTION_MAP.get(p.type)!.meta,inst.settings,job.target.kind,type=>ACTION_MAP.get(type)?.meta);
    if (errors.length) throw new Error(errors.join('; '));
    if (p.type==='sd.page.goto' && !this.engine.store.profile(job.target.profileId)?.pages[String(inst.settings.pageId)]) throw new Error('Choose an existing page');
    if (p.type==='sd.profile' && !this.engine.store.profile(String(inst.settings.profileId))) throw new Error('Choose an existing profile');
    if (p.type.startsWith('agent.')) agentWorkingDirectory(inst.settings.cwd);
    const stateRules = parseStateRules(p.statesJson);
    if (stateRules.length) inst.stateRules = stateRules;
    inst.appearance={...(job.before?.type === inst.type ? job.before.appearance : {}),title:p.title.trim(),icon:{kind:'lucide',name:p.icon},bg:p.color};
    return inst;
  }
  private async run(job: SavedJob, controller: AbortController) {
    try {
      let prompt=this.prompt(job);
      for (let attempt=0;attempt<2;attempt++) {
        const proposal=await this.runner(job.provider,prompt,this.dir,controller.signal);
        if (controller.signal.aborted) return;
        if(proposal?.type==='needs-input' && typeof proposal.summary==='string' && proposal.summary.trim() && proposal.summary.length<=1500) { this.update(job,{status:'needs-input',summary:proposal.summary}); return; }
        this.update(job,{status:'validating'});
        let inst: ActionInstance;
        try { inst=await this.prepare(proposal,job,controller.signal); }
        catch(e) { if (attempt || controller.signal.aborted) throw e; this.update(job,{status:'repairing'}); prompt+=`\nYour previous result failed validation: ${(e as Error).message}. Correct it.`; continue; }
        if (controller.signal.aborted) return;
        const slots=this.slot(job.target);
        if (JSON.stringify(slots[job.target.index]??null)!==JSON.stringify(job.before)) throw new Error('This button changed while the agent was working. Your edits were kept. Select it and try again.');
        // No await between the conflict check and installation.
        job.after=structuredClone(inst);
        this.update(job,{title:proposal.title,icon:proposal.icon,summary:proposal.summary,checks:pChecks(inst)});
        this.install(job, slots, inst);
        this.settle(job,{status:'ready'}); return;
      }
    } catch(e) { if (!controller.signal.aborted) this.settle(job,{status:'failed',error:(e as Error).message}); }
    finally { this.running.delete(job.id); }
  }
}
function pChecks(inst: ActionInstance) { return [...(inst.type==='system.script' ? ['Icon verified','Script syntax checked','Settings validated'] : ['Icon verified','Settings validated']),...(inst.stateRules ? [`${inst.stateRules.length} state rule${inst.stateRules.length===1?'':'s'} validated — look follows this computer`] : []),'Saved to button — runs on press']; }
function parseStateRules(json: string): StateRule[] {
  let raw: unknown;
  try { raw = JSON.parse(json || '[]'); } catch { throw new Error('statesJson must be a JSON array'); }
  if (!Array.isArray(raw)) throw new Error('statesJson must be a JSON array');
  // Agents name Lucide icons; stored rules hold icon references like the button's own icon.
  const rules = raw.map(r => r && typeof r === 'object' && typeof r.icon === 'string' ? { ...r, icon: { kind: 'lucide', name: r.icon } } : r);
  const errors = validateStateRules(rules);
  if (errors.length) throw new Error(`State rules: ${errors.join('; ')}`);
  for (const [i, r] of (rules as StateRule[]).entries()) if (r.icon?.kind === 'lucide' && !existsSync(join(iconsDir, r.icon.name + '.svg'))) throw new Error(`State rule ${i + 1}: choose an existing Lucide icon`);
  return rules as StateRule[];
}
