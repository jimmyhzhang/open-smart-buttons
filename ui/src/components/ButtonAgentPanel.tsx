import { useEffect, useRef, useState, type ReactNode } from 'react';
import { act, client } from '../api.ts';
import { Icon } from './Icon.tsx';
import { isNative, native } from '../native.ts';
import { activeButtonJob, type ButtonJob, type ButtonTarget } from '../../../src/shared/button-agent.ts';

const providerNames = { codex: 'Codex', claude: 'Claude API' };
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
  setupIssue?: string;
  designBlocked?: string;
  deviceId: string;
  canExecute: boolean;
  simulator: boolean;
  browsing: boolean;
  quickActions?: { label: string; icon: string; choose(): void }[];
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
  const provider = 'claude';
  const [editingTarget, setEditingTarget] = useState<string | null>(null);
  const [runFeedback, setRunFeedback] = useState<{ actionId: string | undefined; text: string } | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [problem, setProblem] = useState<{ target: string; message: string } | null>(null);
  const [connectionError, setConnectionError] = useState('');
  const [now, setNow] = useState(Date.now());
  const [tools, setTools] = useState<{ tool: string; installed: boolean }[] | null>(null);
  const [availabilityError, setAvailabilityError] = useState(false);
  const [availabilityCheck, setAvailabilityCheck] = useState(0);
  const request = useRef(0);
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
  const installed = tools?.find(tool => tool.tool === provider)?.installed;
  const busy = !!running || !!pending || jobs.some(job => job.lastRun?.status === 'running');
  const composing = !!p.target && !p.designBlocked && !workingHere &&
    (editingTarget === targetKey || !p.title || !!question);
  const editing = composing && (!!p.title || !!question);
  const canDesign = composing && !!instruction.trim() && !busy && installed === true;
  const runError = runState?.status === 'failed' ? runState.message : error;
  const permission = /accessibility/i.test(runError) ? 'accessibility' : /automation/i.test(runError) ? 'automation' : undefined;

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

  useEffect(() => {
    let live = true;
    setAvailabilityError(false);
    void client.rpc<{ agents: { tool: string; installed: boolean }[] }>('buttonAgent.availability')
      .then(r => { if (live) setTools(r.agents); })
      .catch(() => { if (live) setAvailabilityError(true); });
    return () => { live = false; };
  }, [availabilityCheck]);


  useEffect(() => {
    if (p.browsing || !selectedJob || selectedJob.id !== focusJob.current || activeButtonJob(selectedJob.status)) return;
    focusJob.current = null;
    const focused = document.activeElement;
    if (focused !== document.body && focused !== cancelJobButton.current) return;
    if (selectedJob.status === 'ready') result.current?.focus();
    else if (selectedJob.status === 'needs-input') textarea.current?.focus();
    else if (editButton.current) editButton.current.focus();
    else document.getElementById('key-workspace-title')?.focus();
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
        provider,
        expectedActionId: p.actionId ?? null,
        instruction: !retryOriginal && question && selectedJob
          ? `${selectedJob.instruction}\nQuestion: ${question}\nAdditional detail: ${text}` : text,
      });
      focusJob.current = job.id;
      request.current++;
      setJobs(rows => [...rows.filter(row => row.id !== job.id), job]);
      setInstruction('');
      setEditingTarget(current => current === targetKey ? null : current);
      setNow(Date.now());
      requestAnimationFrame(() => {
        if (document.activeElement === document.body) cancelJobButton.current?.focus();
      });
    });
  }

  function openComposer() {
    setEditingTarget(targetKey);
    setError('');
    requestAnimationFrame(() => textarea.current?.focus());
  }

  function closeComposer() {
    setEditingTarget(null);
    setError('');
    requestAnimationFrame(() => editButton.current?.focus());
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
    if (!p.target || !p.canExecute || busy) return;
    await perform('Running…', async () => {
      try {
        if (saved) await client.rpc('buttonAgent.test', { deviceId: p.deviceId, id: saved.id });
        else {
          await client.rpc('slots.test', { deviceId: p.deviceId, kind: p.target!.kind, index: p.target!.index });
          setRunFeedback({ actionId: p.actionId, text: 'Run completed.' });
        }
      } finally {
        if (saved) await refresh().catch(() => undefined);
      }
    });
  }

  const jobProblem = selectedJob && ['failed', 'cancelled', 'interrupted', 'undone'].includes(selectedJob.status) ? selectedJob : undefined;

  return (
    <aside className="key-studio" aria-label="Key workspace" id="key-workspace" onKeyDown={e => {
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
            if (e.key === 'Enter' && !e.repeat && p.title && !p.designBlocked && !composing && !busy && !p.browsing) {
              e.preventDefault();
              openComposer();
            }
          }}>{p.title || (p.target ? 'Add an action' : 'Choose a key')}</h1>
        </div>
        {p.browsing && <button className="ghost icon-btn studio-close" aria-label="Close action browser" onClick={p.onCloseBrowse}><Icon name="x" size={18}/></button>}
      </header>

      {running && (
        <div className="studio-job" role="status">
          <div className="studio-job-row">
            <span className="studio-spinner" aria-hidden="true" />
            <div><strong>{jobLabels[running.status]}</strong><small>{providerNames[running.provider]} · {targetLabel(running.target)} · {Math.max(0, Math.floor((now - running.startedAt) / 1000))}s</small></div>
            {!workingHere && <button className="ghost" onClick={() => p.onReveal(running.target)}>Show key</button>}
            <button ref={cancelJobButton} className="ghost" disabled={!!pending} onClick={() => cancelDesign(running)}
              onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancelDesign(running); } }}>Stop design</button>
          </div>
        </div>
      )}

      {p.browsing ? p.library : (
        <div className="key-studio-body">
          {!p.target && <p className="studio-description">Select a key on the deck to see what it does or give it a new action.</p>}
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
                <details className="studio-request"><summary>Your request</summary><p>{selectedJob?.instruction}</p></details>
                <p className="studio-question" role="status">{question}</p>
                {selectedJob && <button type="button" className="link" disabled={busy || installed !== true}
                  onClick={() => void start(selectedJob.instruction, true)}>Retry original request</button>}
              </>}
              <small>Submitting shares your request and the selected local action with Claude.</small>
              <textarea id="agent-instruction" ref={textarea} value={instruction} maxLength={6000} rows={3}
                placeholder={question ? 'Add the missing detail…' : p.title ? 'Describe what to change…' : 'Describe an action, e.g. “Lower volume”'}
                onChange={e => setInstruction(e.target.value)} />
              <div className="studio-compose-bar">
                <span className="studio-provider">Claude API</span>
                <div className="studio-compose-buttons">
                  {p.title && !question && <button type="button" className="ghost" onClick={closeComposer}>Cancel</button>}
                  <button className="primary" disabled={!canDesign} type="submit" aria-keyshortcuts="Meta+Enter">
                    {pending || (question ? 'Continue' : p.title ? 'Update key' : 'Create key')} <kbd aria-hidden="true">⌘↩</kbd>
                  </button>
                </div>
              </div>
            </form>
          )}

          {composing && (installed === false || availabilityError) && (
            <p className="studio-error" role="status">
              {availabilityError ? 'Couldn’t check Claude API configuration.' : isNative ? 'Add your Claude API key in Settings ▸ AI, or browse local actions.' : 'Claude API is not configured. See the setup guide or browse local actions.'}
              {!availabilityError && isNative ? <button className="link" onClick={() => void native!.command('settings.open', 'ai')}>Open Settings</button> : null}
              <button className="link" onClick={() => setAvailabilityCheck(n => n + 1)}>Check again</button>
            </p>
          )}

          {jobProblem && !editing && <div className="studio-message" role="status">
            <strong>{jobLabels[jobProblem.status]}</strong>
            {jobProblem.status === 'cancelled' && <p>The key is unchanged.</p>}
            {jobProblem.error && <p>{jobProblem.error}</p>}
            {jobProblem.status !== 'undone' && <button className="link" onClick={() => { setInstruction(jobProblem.instruction); openComposer(); }}>Edit request</button>}
          </div>}

          {p.title && !workingHere && !composing && (
            <div className="studio-action-bar">
              {!p.designBlocked && <button ref={editButton} className="primary" onClick={openComposer}><Icon name="sparkles" size={15}/> Edit with AI…</button>}
              {p.onConfigure && (!p.setupIssue || p.onOpenFolder) && <button className="ghost" onClick={p.onConfigure}>Configure</button>}
              <div className="studio-action-spacer" />
              {p.onOpenFolder ? <button className="primary" onClick={p.onOpenFolder}><Icon name="folder-open" size={15}/> Open folder</button>
                : p.setupIssue && p.onConfigure ? <button className="primary" onClick={p.onConfigure}>Finish setup</button>
                : p.canExecute ? <button className="secondary" disabled={busy || !!p.setupIssue} onClick={() => void run()}><Icon name="play" size={15}/> {pending === 'Running…' || runState?.status === 'running' ? 'Running…' : 'Run'}</button>
                : !p.simulator ? <button className="secondary" onClick={() => void act('settings.update', { patch: { executeActions: true } })}>Enable actions</button> : null}
            </div>
          )}

          {p.title && !p.canExecute && !p.onOpenFolder && !editing && <p className="studio-dry"><Icon name="flask-conical" size={14}/> {p.simulator ? 'Simulators never control your Mac' : 'Mac actions are off'}</p>}
          {saved && !workingHere && !editing && (
            <div className="studio-run" role="status" ref={result} tabIndex={-1}>
              <div className="studio-run-line"><span><Icon name={runState?.status === 'failed' ? 'circle-alert' : 'circle-check'} size={15}/>
                {runState?.status === 'failed' ? 'Run failed' : runState?.status === 'completed' ? 'Run completed' : runState?.status === 'running' || pending === 'Running…' ? 'Running…' : runState?.status === 'blocked' ? 'Run blocked' : 'Saved · Not run yet'}</span>
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
          {!saved && !editing && runFeedback && runFeedback.actionId === p.actionId && !error && <p role="status" className="studio-dry">{runFeedback.text}</p>}
          {!editing && !workingHere && !!p.quickActions?.length && (
            <div className="studio-quick-actions" aria-label="Common actions">
              {p.quickActions.map(action => <button key={action.label} className="secondary" onClick={action.choose}>
                <Icon name={action.icon} size={14}/> {action.label}
              </button>)}
            </div>
          )}
          {!editing && <button id="browse-actions" className={p.target ? 'ghost studio-browse' : 'primary studio-browse'} onClick={p.onBrowse}>
            <Icon name="search" size={16}/> Browse actions <kbd>⌘K</kbd>
          </button>}
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
