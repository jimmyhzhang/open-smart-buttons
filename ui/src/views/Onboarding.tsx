// First-run onboarding (desktop app only, ?view=onboarding). Four calm steps, one primary button each:
// welcome, plug in a deck (live), optional Mac permissions (polled), and login/menu bar choices.

import { useCallback, useEffect, useRef, useState, type CSSProperties, type MutableRefObject, type ReactNode, type RefObject } from 'react';
import { act, client, useAppState, useToasts } from '../api.ts';
import { Icon } from '../components/Icon.tsx';
import { native, useNativeState } from '../native.ts';
import type { AppState, DeviceSummary } from '../../../src/shared/types.ts';
import './onboarding.css';

type PermissionId = 'accessibility' | 'automation';
const STEPS = 4;

export function Onboarding() {
  const { state } = useAppState();
  const [step, setStep] = useState(0);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const primaryRef = useRef<(() => void) | null>(null);
  const ready = state !== null;

  const next = useCallback(() => setStep((s) => Math.min(s + 1, STEPS - 1)), []);

  // Move focus to the new step's heading so screen readers announce it and Enter still works.
  useEffect(() => {
    if (ready) headingRef.current?.focus({ preventScroll: true });
  }, [step, ready]);

  // Enter runs the step's primary action, unless focus is on another button or link that handles Enter itself.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || e.isComposing || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest('button, a, select, textarea, input:not([type=checkbox])')) return;
      if (!primaryRef.current) return;
      e.preventDefault();
      primaryRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!state) {
    return (
      <main className="onb onb-starting" aria-busy="true">
        <div className="onb-spinner" aria-hidden />
        <p className="onb-starting-text" role="status">Starting…</p>
      </main>
    );
  }

  const stepProps = { state, headingRef, primaryRef, next };
  return (
    <main className="onb">
      <div className="onb-step" key={step}>
        {step === 0 && <Welcome {...stepProps} />}
        {step === 1 && <PlugIn {...stepProps} />}
        {step === 2 && <Permissions {...stepProps} />}
        {step === 3 && <Finish {...stepProps} />}
      </div>
      <ErrorNote />
    </main>
  );
}

interface StepProps {
  state: AppState;
  headingRef: RefObject<HTMLHeadingElement | null>;
  primaryRef: MutableRefObject<(() => void) | null>;
  next: () => void;
}

/** Shared step frame: hero, heading, body, and a footer with the step dots and the one primary button. */
function Step({ hero, title, body, children, footer, headingRef, index }: {
  hero?: ReactNode; title: string; body?: ReactNode; children?: ReactNode; footer: ReactNode;
  headingRef: StepProps['headingRef']; index: number;
}) {
  return (
    <>
      <div className="onb-body">
        {hero && <div className="onb-hero">{hero}</div>}
        <h1 className="onb-title" ref={headingRef} tabIndex={-1}>{title}</h1>
        {body && <p className="onb-lede">{body}</p>}
        {children}
      </div>
      <footer className="onb-footer">
        <StepDots index={index} />
        <div className="onb-actions">{footer}</div>
      </footer>
    </>
  );
}

function StepDots({ index }: { index: number }) {
  return (
    <div className="onb-dots" role="img" aria-label={`Step ${index + 1} of ${STEPS}`}>
      {Array.from({ length: STEPS }, (_, i) => (
        <span key={i} className={i === index ? 'on' : i < index ? 'done' : ''} />
      ))}
    </div>
  );
}

function Primary({ label, onClick, disabled, busy, primaryRef }: {
  label: string; onClick: () => void; disabled?: boolean; busy?: boolean; primaryRef: StepProps['primaryRef'];
}) {
  const off = disabled || busy;
  // Set after commit so the previous step's cleanup can't clear the new step's action.
  useEffect(() => {
    primaryRef.current = off ? null : onClick;
    return () => { primaryRef.current = null; };
  });
  return (
    <button type="button" className="onb-primary" onClick={onClick} disabled={off} aria-busy={busy || undefined}>
      {label}
    </button>
  );
}

// ---- 1. Welcome ------------------------------------------------------------------------------------

function Welcome({ headingRef, primaryRef, next }: StepProps) {
  return (
    <Step
      index={0}
      headingRef={headingRef}
      hero={<DeckArt columns={4} rows={2} encoders={0} lit="wave" />}
      title="Your Stream Deck, without the Stream Deck app."
      body="Design your keys, switch profiles and control your Mac from one small, quiet app."
      footer={<Primary label="Get Started" onClick={next} primaryRef={primaryRef} />}
    />
  );
}

// ---- 2. Plug in --------------------------------------------------------------------------------------

function PlugIn({ state, headingRef, primaryRef, next }: StepProps) {
  const nativeState = useNativeState();
  const usb = state.devices.find((d) => d.kind === 'usb');
  const sim = state.devices.find((d) => d.kind === 'sim');
  const deck = usb ?? sim;
  const [quitting, setQuitting] = useState(false);
  const [trying, setTrying] = useState(false);

  const elgato = nativeState?.elgato;
  const elgatoName = elgato?.name || 'Elgato Stream Deck';
  const blocked = !usb && !!elgato?.running;
  const hidError = !usb && state.platform.hidError;
  const stuck = !usb && !blocked ? state.discovered.find((d) => d.kind === 'usb' && (d.error || !d.supported)) : undefined;

  // The 5 s reconnect picks the deck up after Elgato quits; stop showing "Connecting…" once it arrives or Elgato is back.
  useEffect(() => {
    if (!quitting) return;
    if (usb || elgato?.reopened) { setQuitting(false); return; }
    const t = setTimeout(() => setQuitting(false), 12000);
    return () => clearTimeout(t);
  }, [quitting, usb, elgato?.reopened]);

  const quitElgato = async () => {
    if (!native) return;
    setQuitting(true);
    try { await native.command('elgato.quit'); } catch { setQuitting(false); }
  };

  const tryWithout = async () => {
    setTrying(true);
    const id = sim ? sim.id : await act<string>('sim.add', { modelId: 'plus' });
    setTrying(false);
    if (id) next();
  };

  let status: ReactNode;
  if (usb) {
    status = <StatusLine tone="ok" icon="check">{usb.modelName} is connected.</StatusLine>;
  } else if (hidError) {
    status = <StatusLine tone="danger" icon="circle-alert">Device support didn't load. Reinstall StreamDeckPlus.</StatusLine>;
  } else if (blocked) {
    status = (
      <div className="onb-callout">
        <div className="onb-callout-text">
          <strong>{elgatoName} is using your deck.</strong>
          <span>{elgato?.reopened
            ? 'Stream Deck reopened. Turn off its Open at Login.'
            : 'Quit it so StreamDeckPlus can connect.'}</span>
        </div>
        <button type="button" className="onb-secondary" onClick={quitElgato} disabled={quitting || !native}>
          {quitting ? 'Connecting…' : 'Quit It and Connect'}
        </button>
      </div>
    );
  } else if (stuck) {
    status = (
      <StatusLine tone="warn" icon="circle-alert">
        {stuck.supported
          ? `Your ${stuck.modelName} didn't respond. Unplug it and plug it back in.`
          : `${stuck.modelName} isn't supported yet.`}
      </StatusLine>
    );
  } else if (sim) {
    status = <StatusLine tone="ok" icon="check">You're trying a virtual {sim.modelName}. Plug in your deck any time.</StatusLine>;
  } else {
    status = <StatusLine tone="wait">Looking for your deck…</StatusLine>;
  }

  return (
    <Step
      index={1}
      headingRef={headingRef}
      hero={<DeckArt device={deck} lit={usb ? 'on' : sim ? 'on' : 'off'} columns={4} rows={2} encoders={4} />}
      title="Plug in your Stream Deck."
      body="Use a USB-C cable. A Stream Deck Neo or Stream Deck + is found as soon as it's connected."
      footer={
        <>
          {!usb && (
            <button type="button" className="onb-link" onClick={tryWithout} disabled={trying}>
              {sim ? 'Continue without a deck' : 'Try without a deck'}
            </button>
          )}
          <Primary label="Continue" onClick={next} disabled={!deck} primaryRef={primaryRef} />
        </>
      }
    >
      <div className="onb-status" aria-live="polite">{status}</div>
    </Step>
  );
}

function StatusLine({ tone, icon, children }: { tone: 'ok' | 'warn' | 'danger' | 'wait'; icon?: string; children: ReactNode }) {
  return (
    <p className={`onb-line ${tone}`}>
      {tone === 'wait' ? <span className="onb-pulse" aria-hidden /> : icon && <Icon name={icon} size={15} />}
      <span>{children}</span>
    </p>
  );
}

/** A small deck drawn in CSS: keys light up when a deck is connected, and dials appear for Stream Deck +. */
function DeckArt({ device, columns, rows, encoders, lit }: {
  device?: DeviceSummary; columns: number; rows: number; encoders: number; lit: 'on' | 'off' | 'wave';
}) {
  const cols = device?.columns ?? columns;
  const rws = device?.rows ?? rows;
  const dials = device ? device.encoders : encoders;
  const neo = device ? device.touchPoints > 0 && device.encoders === 0 : false;
  return (
    <div className={`onb-deck ${lit}`} aria-hidden>
      <div className="onb-keys" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
        {Array.from({ length: cols * rws }, (_, i) => (
          <span key={i} className="onb-key" style={{ '--i': i } as CSSProperties} />
        ))}
      </div>
      {dials > 0 && (
        <div className="onb-strip">
          <div className="onb-lcd" />
          <div className="onb-dials">
            {Array.from({ length: dials }, (_, i) => <span key={i} className="onb-dial" />)}
          </div>
        </div>
      )}
      {neo && <div className="onb-neo-bar"><span /><div className="onb-lcd" /><span /></div>}
    </div>
  );
}

// ---- 3. Permissions ----------------------------------------------------------------------------------

const PERMISSION_COPY: Record<PermissionId, { label: string; detail: string }> = {
  accessibility: { label: 'Accessibility', detail: 'Lets keys send shortcuts, media keys and scrolling.' },
  automation: { label: 'Automation', detail: 'Lets keys type text and run shortcuts through System Events.' },
};

function Permissions({ state, headingRef, primaryRef, next }: StepProps) {
  const prompted = useRef(false);
  const executeActions = state.config.settings.executeActions;
  const [actionsOn, setActionsOn] = useState(executeActions);
  useEffect(() => { setActionsOn(executeActions); }, [executeActions]);

  // One source of truth: re-run the permission check every second while this window has focus.
  useEffect(() => {
    const check = () => {
      if (client.connected && document.hasFocus()) client.rpc('platform.permissions', { prompt: false }).catch(() => {});
    };
    check();
    const t = setInterval(check, 1000);
    return () => clearInterval(t);
  }, []);

  const open = (id: PermissionId) => {
    if (!prompted.current) {
      prompted.current = true;
      void act('platform.permissions', { prompt: true });
    }
    if (native) void native.command('permissions.open', id).catch(() => {});
    else void act('platform.openSettings', { id });
  };

  const toggleActions = (on: boolean) => {
    setActionsOn(on);
    void act('settings.update', { patch: { executeActions: on } });
  };

  const rows = (['accessibility', 'automation'] as const).map((id) => ({
    id,
    ok: state.platform.permissions.find((p) => p.id === id)?.ok ?? null,
    ...PERMISSION_COPY[id],
  }));

  return (
    <Step
      index={2}
      headingRef={headingRef}
      title="Let StreamDeckPlus press keys for you."
      body="Optional. Keys that send shortcuts or type text need your Mac's permission."
      footer={<Primary label="Continue" onClick={next} primaryRef={primaryRef} />}
    >
      <div className="onb-group">
        <label className="onb-row onb-row-toggle">
          <span className="onb-row-text">
            <span className="onb-row-label">Let keys control your Mac</span>
            <span className="onb-row-detail">Off until you turn it on. You can pause it from the menu bar.</span>
          </span>
          <Switch checked={actionsOn} onChange={toggleActions} />
        </label>
        {rows.map((r) => (
          <div className="onb-row" key={r.id}>
            <span className={`onb-perm-icon ${r.ok ? 'ok' : ''}`} aria-hidden>
              <Icon name={r.id === 'accessibility' ? 'keyboard' : 'workflow'} size={16} />
            </span>
            <span className="onb-row-text">
              <span className="onb-row-label">{r.label}</span>
              <span className="onb-row-detail">{r.detail}</span>
            </span>
            {r.ok ? (
              <span className="onb-check" role="img" aria-label={`${r.label} allowed`}><Icon name="check" size={14} /></span>
            ) : (
              <button type="button" className="onb-secondary" onClick={() => open(r.id)}>Open System Settings</button>
            )}
          </div>
        ))}
      </div>
      <p className="onb-note">Skip — you can do this later in Settings.</p>
    </Step>
  );
}

// ---- 4. Finish ---------------------------------------------------------------------------------------

function Finish({ headingRef, primaryRef }: StepProps) {
  const nativeState = useNativeState();
  const [openAtLogin, setOpenAtLogin] = useState(true);
  const [showInMenuBar, setShowInMenuBar] = useState(true);
  const [busy, setBusy] = useState(false);
  const seeded = useRef(false);

  // Start from the app's saved choices once they arrive; both default to on.
  useEffect(() => {
    if (seeded.current || !nativeState) return;
    seeded.current = true;
    setOpenAtLogin(nativeState.prefs.openAtLogin ?? true);
    setShowInMenuBar(nativeState.prefs.showInMenuBar ?? true);
  }, [nativeState]);

  const finish = async () => {
    setBusy(true);
    if (!native) { location.href = location.pathname; return; }
    try { await native.command('onboarding.finish', { openAtLogin, showInMenuBar }); } catch { setBusy(false); }
  };

  return (
    <Step
      index={3}
      headingRef={headingRef}
      hero={<div className="onb-done" aria-hidden><Icon name="check" size={28} /></div>}
      title="You're set."
      body="Pick how StreamDeckPlus fits into your day. You can change this in Settings."
      footer={<Primary label="Open StreamDeckPlus" onClick={finish} busy={busy} primaryRef={primaryRef} />}
    >
      <div className="onb-group">
        <label className="onb-row onb-row-toggle">
          <span className="onb-row-text">
            <span className="onb-row-label">Open at login</span>
            <span className="onb-row-detail">Your keys work as soon as you sign in.</span>
          </span>
          <Switch checked={openAtLogin} onChange={setOpenAtLogin} />
        </label>
        <label className="onb-row onb-row-toggle">
          <span className="onb-row-text">
            <span className="onb-row-label">Show in menu bar</span>
            <span className="onb-row-detail">
              {showInMenuBar ? 'Switch profiles and brightness from the menu bar.' : 'StreamDeckPlus stays in the Dock instead.'}
            </span>
          </span>
          <Switch checked={showInMenuBar} onChange={setShowInMenuBar} />
        </label>
      </div>
    </Step>
  );
}

// ---- shared bits -------------------------------------------------------------------------------------

function Switch({ checked, onChange }: { checked: boolean; onChange: (on: boolean) => void }) {
  return (
    <input
      type="checkbox"
      role="switch"
      className="onb-switch"
      checked={checked}
      aria-checked={checked}
      onChange={(e) => onChange(e.currentTarget.checked)}
    />
  );
}

/** The editor's toasts are not drawn here, so show the latest error quietly under the step. */
function ErrorNote() {
  const toasts = useToasts();
  const last = [...toasts].reverse().find((t) => t.kind === 'error');
  return <p className="onb-error" role="alert">{last?.msg ?? ''}</p>;
}
