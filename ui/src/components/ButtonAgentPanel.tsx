import { useEffect, useRef, useState, type ReactNode } from 'react';
import { act, client, toast } from '../api.ts';
import { Icon } from './Icon.tsx';
import { isNative, native, useNativeState } from '../native.ts';
import { activeButtonJob, aiEngineName, type AiStatus, type ButtonJob, type ButtonTarget } from '../../../src/shared/button-agent.ts';
import type { AgentTask } from '../../../src/shared/agent-task.ts';

const jobLabels: Record<ButtonJob['status'], string> = {
  creating: 'Designing…', validating: 'Checking setup…', repairing: 'Correcting setup…',
  ready: 'Saved', 'needs-input': 'One detail needed', failed: 'Design failed',
  interrupted: 'Design interrupted', cancelled: 'Design cancelled', undone: 'Previous action restored',
};
const targetLabel = (target: ButtonTarget) => `${target.kind === 'key' ? 'Key' : 'Dial'} ${target.index + 1}`;

interface Props {
  target: ButtonTarget | null;
  title?: string;
  actionId?: string;
  icon?: string;
  actionDescription?: string;
  backgroundAgent?: boolean;
  agentTask?: AgentTask;
  setupIssue?: string;
  designBlocked?: string;
  deviceId: string;
  canExecute: boolean;
  simulator: boolean;
  browsing: boolean;
  presets: ReactNode;
  library: ReactNode;
  advanced?: ReactNode;
  onBrowse(): void;
  onCloseBrowse(): void;
  onConfigure?: () => void;
  onOpenFolder?: () => void;
  onReveal(target: ButtonTarget): void;
}

export function ButtonAgentPanel(p: Props) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [jobs, setJobs] = useState<ButtonJob[]>([]);
  const [editingTarget, setEditingTarget] = useState<string | null>(null);
  const [runFeedback, setRunFeedback] = useState<{ actionId: string | undefined; text: string } | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [problem, setProblem] = useState<{ target: string; message: string } | null>(null);
  const [connectionError, setConnectionError] = useState('');
  const [now, setNow] = useState(Date.now());
  const [ai, setAi] = useState<AiStatus | null>(null);
  const [availabilityError, setAvailabilityError] = useState(false);
  const [availabilityCheck, setAvailabilityCheck] = useState(0);
  const request = useRef(0);
  const workspace = useRef<HTMLElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const editButton = useRef<HTMLButtonElement>(null);
  const cancelJobButton = useRef<HTMLButtonElement>(null);
  const result = useRef<HTMLDivElement>(null);
  const focusJob = useRef<string | null>(null);
  const targetKey = JSON.stringify(p.target);
  const error = problem?.target === targetKey ? problem.message : '';
  const setError = (message: string) => setProblem(message ? { target: targetKey, message } : null);
  const instruction = drafts[targetKey] || '';
  const setInstruction = (value: string) => setDrafts(d => ({ ...d, [targetKey]: value }));
  const running = jobs.find(job => activeButtonJob(job.status));
  const keyJobs = [...jobs].reverse().filter(job => JSON.stringify(job.target) === targetKey);
  const selectedJob = keyJobs[0];
  const saved = keyJobs.find(job => job.status === 'ready' && job.applied !== false);
  const workingHere = !!running && JSON.stringify(running.target) === targetKey;
  const question = selectedJob?.status === 'needs-input' ? selectedJob.summary : undefined;
  const runState = saved?.lastRun;
  const feedback = runFeedback?.actionId === p.actionId ? runFeedback?.text : undefined;
  const engine = ai?.active ? ai.engines.find(e => e.id === ai.active) : undefined;
  const installed = ai ? !!engine : undefined;
  const taskRunning = p.agentTask?.status === 'running';
  const busy = !!running || !!pending || taskRunning || jobs.some(job => job.lastRun?.status === 'running');
  const runningButton = taskRunning || pending === 'Testing…' || pending === 'Running…' || runState?.status === 'running';
  const composing = !!p.target && !p.designBlocked && !workingHere &&
    (editingTarget === targetKey || (!p.title && installed === true) || !!question);
  const editing = composing && (!!p.title || !!question);
  const canDesign = composing && !!instruction.trim() && !busy && installed === true;
  const needsAiSetup = !!p.target && !p.designBlocked && !workingHere && installed === false;
  const showAiIntro = !p.designBlocked && !workingHere && !composing && (!p.target || !p.title);
  const showAiSettings = () => void native?.command('settings.open', 'ai')
    .catch(() => toast("Couldn't open AI settings. Try again.", 'error'));
  const runError = runState?.status === 'failed' ? runState.message : error;
  const permission = /accessibility/i.test(runError) ? 'accessibility' : /automation/i.test(runError) ? 'automation' : undefined;

  useEffect(() => {
    workspace.current?.scrollTo({ top: 0 });
  }, [targetKey, p.browsing, editing]);
  useEffect(() => {
    if (!taskRunning) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [taskRunning]);

  async function refresh() {
    const id = ++request.current;
    const rows = await client.rpc<ButtonJob[]>('buttonAgent.list');
    if (id === request.current) {
      setJobs(rows);
      setNow(Date.now());
      setConnectionError('');
    }
    return rows;
  }

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      let interval = 2500;
      try {
        const rows = await refresh();
        if (rows.some(job => activeButtonJob(job.status) || job.lastRun?.status === 'running')) interval = 900;
      } catch {
        if (!stopped) setConnectionError('Design status is unavailable. Reconnecting…');
      } finally {
        if (!stopped) timer = setTimeout(poll, interval);
      }
    };
    void poll();
    return () => { stopped = true; clearTimeout(timer); request.current++; };
  }, []);

  // The assignment state reaches the editor before the next job poll.
  useEffect(() => {
    if (workingHere && p.actionId) void refresh().catch(() => { /* The job poll retries. */ });
  }, [p.actionId]);

  // Settings is another window: pick up an engine or key change made there, or a sign-in in Terminal.
  const ns = useNativeState();
  useEffect(() => {
    const again = () => setAvailabilityCheck(n => n + 1);
    window.addEventListener('focus', again);
    return () => window.removeEventListener('focus', again);
  }, []);
  useEffect(() => { if (ns) setAvailabilityCheck(n => n + 1); }, [ns?.ai.provider, ns?.ai.hasKey]);

  useEffect(() => {
    let live = true;
    setAvailabilityError(false);
    void client.rpc<AiStatus>('buttonAgent.availability', { refresh: availabilityCheck > 0 })
      .then(r => { if (live) setAi(r); })
      .catch(() => { if (live) setAvailabilityError(true); });
    return () => { live = false; };
  }, [availabilityCheck]);


  useEffect(() => {
    if (p.browsing || !selectedJob || selectedJob.id !== focusJob.current || activeButtonJob(selectedJob.status)) return;
    focusJob.current = null;
    const retryInPlace = selectedJob.status === 'failed' && !p.title;
    if (retryInPlace) setDrafts(current => ({ ...current, [targetKey]: selectedJob.instruction }));
    const focused = document.activeElement;
    if (focused !== document.body && focused !== cancelJobButton.current) return;
    if (selectedJob.status === 'ready') result.current?.focus({ preventScroll: true });
    else if (selectedJob.status === 'needs-input' || retryInPlace) textarea.current?.focus({ preventScroll: true });
    else if (editButton.current) editButton.current.focus({ preventScroll: true });
    else document.getElementById('key-workspace-title')?.focus({ preventScroll: true });
  }, [p.browsing, selectedJob?.id, selectedJob?.status]);

  async function perform(label: string, task: () => Promise<unknown>) {
    setError('');
    setPending(label);
    try { await task(); }
    catch (e) { setError((e as Error).message); }
    finally { setPending(null); }
  }

  async function start(text: string, retryOriginal = false) {
    if (!p.target || busy || installed !== true || !text.trim()) return;
    await perform('Starting…', async () => {
      const job = await client.rpc<ButtonJob>('buttonAgent.start', {
        target: p.target,
        expectedActionId: p.actionId ?? null,
        instruction: !retryOriginal && question && selectedJob
          ? `${selectedJob.instruction}\n\nThe previous response asked: ${question}\nThe user has now answered: ${text}\nUse this answer to complete the request. This answer supersedes the earlier request to ask that question. Ask again only if essential information is still missing.` : text,
      });
      focusJob.current = job.id;
      request.current++;
      setJobs(rows => [...rows.filter(row => row.id !== job.id), job]);
      setInstruction('');
      setEditingTarget(current => current === targetKey ? null : current);
      setNow(Date.now());
      requestAnimationFrame(() => {
        if (document.activeElement === document.body) cancelJobButton.current?.focus({ preventScroll: true });
      });
    });
  }

  function openComposer() {
    setEditingTarget(targetKey);
    setError('');
    requestAnimationFrame(() => textarea.current?.focus({ preventScroll: true }));
  }

  function closeComposer() {
    setEditingTarget(null);
    setError('');
    requestAnimationFrame(() => editButton.current?.focus({ preventScroll: true }));
  }

  function cancelDesign(job: ButtonJob) {
    void perform('Cancelling…', async () => {
      await client.rpc('buttonAgent.cancel', { id: job.id });
      await refresh();
    });
  }

  function undoDesign(job: ButtonJob) {
    void perform('Restoring…', async () => {
      await client.rpc('buttonAgent.undo', { id: job.id });
      await refresh();
    });
  }

  async function run() {
    if (!p.target || (!p.canExecute && !p.simulator) || busy) return;
    await perform(p.simulator ? 'Testing…' : 'Running…', async () => {
      try {
        if (saved && !p.simulator && !p.backgroundAgent) await client.rpc('buttonAgent.test', { deviceId: p.deviceId, id: saved.id });
        else {
          await client.rpc('slots.test', { deviceId: p.deviceId, kind: p.target!.kind, index: p.target!.index });
          if (p.simulator || !p.backgroundAgent) setRunFeedback({ actionId: p.actionId, text: p.simulator ? 'Tested in the simulator. No Mac actions were performed.' : 'Run completed.' });
        }
      } finally {
        if (saved && !p.simulator) await refresh().catch(() => undefined);
      }
    });
  }

  const jobProblem = selectedJob && ['failed', 'cancelled', 'interrupted', 'undone'].includes(selectedJob.status) ? selectedJob : undefined;

  return (
    <aside ref={workspace} className="key-studio" aria-label="Key workspace" id="key-workspace" onKeyDown={e => {
      if (saved && !busy && !p.browsing && !editing && e.metaKey && !e.shiftKey && e.key.toLowerCase() === 'z'
        && !(e.target instanceof Element && e.target.closest('input, textarea, select, [contenteditable]'))) {
        e.preventDefault();
        e.stopPropagation();
        undoDesign(saved);
      }
    }}>
      <header className="key-studio-head">
        <span className="studio-key-icon"><Icon name={p.icon || (p.target ? 'plus' : 'layout-grid')} size={22}/></span>
        <div>
          <p>{p.target ? targetLabel(p.target) : 'Key workspace'}</p>
          <h1 id="key-workspace-title" tabIndex={-1} onKeyDown={e => {
            if (e.key === 'Enter' && !e.repeat && p.title && installed === true && !p.designBlocked && !composing && !busy && !p.browsing) {
              e.preventDefault();
              openComposer();
            }
          }}>{p.browsing ? 'Manual setup' : p.title || (p.target ? 'Add an action' : 'Set up your deck')}</h1>
        </div>
        {p.browsing && <button className="ghost icon-btn studio-close" aria-label="Close manual setup" onClick={p.onCloseBrowse}><Icon name="x" size={18}/></button>}
      </header>

      {running && (
        <div className="studio-job">
          <div className="studio-job-row">
            <span className="studio-spinner" aria-hidden="true" />
            <div role="status">
              <strong>{jobLabels[running.status]}</strong>
              <small>{aiEngineName[running.provider] ?? running.provider} · {targetLabel(running.target)}
                <span aria-hidden="true"> · {Math.max(0, Math.floor((now - running.startedAt) / 1000))}s</span>
              </small>
            </div>
            {!workingHere && <button className="ghost" onClick={() => p.onReveal(running.target)}>Show key</button>}
            <button ref={cancelJobButton} className="ghost" disabled={!!pending} onClick={() => cancelDesign(running)}
              onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancelDesign(running); } }}>Stop design</button>
          </div>
        </div>
      )}

      {p.browsing ? p.library : (
        <div className="key-studio-body">
          {showAiIntro && (
            <section className="studio-ai-intro" aria-label="AI design">
              <h2><Icon name="sparkles" size={16} /> {p.target ? 'Create with AI' : 'Create or edit with AI'}</h2>
              <p>{!p.target ? 'Select an empty key to create an action or a configured key to edit it.' : 'Describe what this key should do.'}</p>
              {installed === false && isNative && <button className="primary" onClick={showAiSettings}>Set up AI…</button>}
              {availabilityError && <button className="link" onClick={() => setAvailabilityCheck(n => n + 1)}>Check AI again</button>}
            </section>
          )}
          {p.target && p.title && !workingHere && <p className="studio-description">{p.setupIssue || p.actionDescription || saved?.summary}</p>}

          {composing && (
            <form className="studio-compose" onSubmit={e => { e.preventDefault(); if (canDesign) void start(instruction); }}
              onKeyDown={e => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  if (canDesign && !e.repeat) void start(instruction);
                } else if (e.key === 'Escape' && p.title && !question && !(e.target instanceof HTMLSelectElement)) {
                  e.preventDefault();
                  e.stopPropagation();
                  closeComposer();
                } else if (e.key === 'Escape' && p.target?.kind === 'key' && !(e.target instanceof HTMLSelectElement)) {
                  e.preventDefault();
                  e.stopPropagation();
                  document.getElementById(`deck-key-${p.target.index}`)?.focus();
                }
              }}>
              <label className="studio-compose-label" htmlFor="agent-instruction">{question ? 'Answer the design question' : p.title ? 'Edit with AI' : 'Create with AI'}</label>
              {question && <>
                <p className="studio-question" id="agent-question" role="status">{question}</p>
                <details className="studio-request">
                  <summary>Original request</summary>
                  <p>{selectedJob?.instruction}</p>
                  {selectedJob && <button type="button" className="link" disabled={busy || installed !== true}
                    onClick={() => void start(selectedJob.instruction, true)}>Retry original request</button>}
                </details>
              </>}
              <small id="agent-disclosure">Submitting shares your request and the selected key with {engine?.vendor ?? 'the AI engine'}.</small>
              <textarea id="agent-instruction" aria-describedby={question ? 'agent-question agent-disclosure' : 'agent-disclosure'} ref={textarea} value={instruction} maxLength={6000} rows={3}
                placeholder={question ? 'Add the missing detail…' : p.title ? 'Describe what to change…' : 'Describe an action, e.g. “Lower volume”'}
                onChange={e => setInstruction(e.target.value)} />
              <div className="studio-compose-bar">
                <span className="studio-provider" title="Change in Settings ▸ AI">{engine?.name ?? 'No AI engine'}</span>
                <div className="studio-compose-buttons">
                  {p.title && !question && <button type="button" className="ghost" onClick={closeComposer}>Cancel</button>}
                  <button className="primary" disabled={!canDesign} type="submit" aria-keyshortcuts="Meta+Enter">
                    {pending || (question ? 'Send answer' : p.title ? 'Update key' : 'Create key')} <kbd aria-hidden="true">⌘↩</kbd>
                  </button>
                </div>
              </div>
            </form>
          )}

          {composing && (installed === false || availabilityError) && (
            <p className="studio-error" role="status">
              {availabilityError ? 'Couldn’t check the AI engines.' : `${(isNative ? ai?.message : ai?.message?.replace(/ in Settings ▸ AI|, or choose another engine in Settings ▸ AI/g, '')) ?? 'No AI engine is ready.'}${isNative ? '' : ' From Terminal, you can also start with ANTHROPIC_API_KEY.'}`}
              {!availabilityError && isNative ? <button className="link" onClick={showAiSettings}>Open AI Settings</button> : null}
              <button className="link" onClick={() => setAvailabilityCheck(n => n + 1)}>Check again</button>
            </p>
          )}

          {jobProblem && !editing && <div className="studio-message" role="status">
            <strong>{jobLabels[jobProblem.status]}</strong>
            {jobProblem.status === 'cancelled' && <p>The key is unchanged.</p>}
            {jobProblem.error && <p>{jobProblem.error}</p>}
            {jobProblem.status !== 'undone' && (!composing || !instruction.trim()) && <button className="link" onClick={() => { setInstruction(jobProblem.instruction); openComposer(); }}>Edit request</button>}
          </div>}

          {p.title && !workingHere && !composing && (
            <div className="studio-action-bar studio-key-actions">
              {!p.designBlocked && installed === true && <button ref={editButton} className="primary" disabled={taskRunning} onClick={openComposer}><Icon name="sparkles" size={15}/> Edit with AI…</button>}
              {p.onConfigure && (!p.setupIssue || p.onOpenFolder) && <button disabled={taskRunning} className={installed === true || p.onOpenFolder ? 'ghost' : 'primary'} onClick={p.onConfigure}>Configure</button>}
              {p.onOpenFolder ? <button className="primary" onClick={p.onOpenFolder}><Icon name="folder-open" size={15}/> Open folder</button>
                : p.setupIssue && p.onConfigure ? <button className="primary" onClick={p.onConfigure}>Finish setup</button>
                : p.canExecute || p.simulator ? <button className="secondary" disabled={busy || !!p.setupIssue} aria-busy={runningButton} onClick={() => void run()}>
                  {runningButton ? <span className="osb-spinner" aria-hidden="true" /> : <Icon name="play" size={15} />} {p.simulator ? 'Test' : 'Run'}
                </button>
                : !p.simulator ? <button className="secondary" onClick={() => void act('settings.update', { patch: { executeActions: true } })}>Enable actions</button> : null}
            </div>
          )}

          {p.backgroundAgent && p.agentTask && <section className="studio-run agent-task-result" aria-label="Prompt execution">
            <div className="studio-run-line">
              <span role="status">
                {taskRunning ? <span className="osb-spinner" aria-hidden="true" /> : <Icon name={p.agentTask.status === 'failed' ? 'circle-alert' : p.agentTask.status === 'cancelled' ? 'circle-stop' : 'circle-check'} size={15} />}
                {{ running: 'Running prompt…', completed: 'Prompt completed', failed: 'Prompt failed', cancelled: 'Prompt stopped' }[p.agentTask.status]}
              </span>
              {taskRunning && <button className="ghost" disabled={pending === 'Stopping…'} onClick={() => void perform('Stopping…', async () => {
                await client.rpc('agentTasks.cancel', { id: p.agentTask!.id });
              })}>{pending === 'Stopping…' ? 'Stopping…' : 'Stop task'}</button>}
            </div>
            <p className="small muted">{p.agentTask.tool === 'claude' ? 'Claude Code' : 'Codex'}
              {taskRunning && <span aria-hidden="true"> · {Math.max(0, Math.floor((now - p.agentTask.startedAt) / 1000))}s</span>}
            </p>
            {p.agentTask.error && <p className="studio-error" role="alert">{p.agentTask.error}</p>}
            {p.agentTask.output && <pre className="agent-task-output" tabIndex={0} aria-label="Agent response">{p.agentTask.output}</pre>}
          </section>}

          {p.title && !workingHere && !p.canExecute && !p.onOpenFolder && !editing && !(p.simulator && feedback) && <p className="studio-dry"><Icon name="flask-conical" size={14}/> {p.simulator ? 'Tests run in the simulator' : 'Mac actions are off'}</p>}
          {saved && !workingHere && !editing && (
            <div className="studio-run" role="status" ref={result} tabIndex={-1}>
              <div className="studio-run-line"><span><Icon name={runState?.status === 'failed' ? 'circle-alert' : 'circle-check'} size={15}/>
                {p.backgroundAgent ? 'Button saved' : runState?.status === 'failed' ? 'Run failed' : runState?.status === 'completed' ? 'Run completed' : runState?.status === 'running' || pending === 'Running…' ? 'Running…' : runState?.status === 'blocked' ? 'Run blocked' : p.simulator ? 'Saved' : 'Saved · Not run yet'}</span>
                <button className="link" disabled={busy} aria-keyshortcuts="Meta+Z" onClick={() => undoDesign(saved)}>Undo change</button>
              </div>
              {runState?.status === 'failed' && <><p>{runState.message}</p><button className="link" onClick={() => {
                setInstruction(`${saved.instruction}\nThe action failed when run: ${runState.message}\nFix this while keeping the intended behavior.`.slice(0, 6000));
                openComposer();
              }}>Fix with AI</button></>}
              {runState?.output && <details><summary>Run output</summary><pre>{runState.output}</pre></details>}
              {!!saved.checks?.length && <details><summary>Setup checks</summary><ul>{saved.checks.map(check => <li key={check}>{check}</li>)}</ul></details>}
            </div>
          )}
          {!editing && permission && <button className="secondary studio-recovery" onClick={() => void act('platform.openSettings', { id: permission })}>Open System Settings…</button>}
          {(!p.backgroundAgent || p.simulator) && (!saved || p.simulator) && !editing && feedback && !error && <p role="status" className="studio-run-feedback">{feedback}</p>}
          {!editing && !workingHere && (p.title
            ? <details className="studio-preset-disclosure"><summary>Preset button groups</summary>{p.presets}</details>
            : p.presets)}
          {!editing && <div className="studio-action-bar studio-browse-row">
            <button id="browse-actions" className="ghost studio-browse" disabled={taskRunning} onClick={p.onBrowse}>
              <Icon name="sliders-horizontal" size={16}/> Set up manually <kbd aria-hidden="true">⌘K</kbd>
            </button>
            {needsAiSetup && p.title && isNative && <button className="ghost studio-ai-setup" onClick={showAiSettings}>
              <Icon name="sparkles" size={15}/> Set up AI…
            </button>}
            {p.title && !p.designBlocked && availabilityError && !composing &&
              <button className="link" onClick={() => setAvailabilityCheck(n => n + 1)}>Check AI again</button>}
          </div>}
        </div>
      )}

      {((error && error !== runState?.message) || connectionError) && <p role="alert" className="studio-error studio-panel-error">{error || connectionError}</p>}
      {!p.browsing && !editing && (p.advanced || jobs.length > 0) && <footer className="key-studio-foot">
        {p.advanced && <details key={targetKey}><summary>More key options</summary>{p.advanced}</details>}
        {!!jobs.length && <details><summary>Design history</summary><div className="studio-history">{[...jobs].reverse().slice(0, 5).map(job => (
          <button key={job.id} className="ghost" onClick={() => p.onReveal(job.target)}><span>{job.title || targetLabel(job.target)}</span><small>{jobLabels[job.status]}</small></button>
        ))}<button className="link" disabled={busy} onClick={() => {
          if (!window.confirm('Clear design history and its undo records? Your saved buttons stay in place.')) return;
          void perform('Clearing…', async () => {
            await client.rpc('buttonAgent.clearHistory');
            await refresh();
          });
        }}>Clear design history…</button></div></details>}
      </footer>}
    </aside>
  );
}
