import { canConfigureLocalAction, externalActionMessage, isLocalAction } from '../../src/shared/local-action-policy.ts';
import { useEffect, useMemo, useRef, useState } from 'react';
import { act, client, dismissToast, runLatestToastAction, toast, useAppState, useToasts } from './api.ts';
import type { ButtonTarget } from '../../src/shared/button-agent.ts';
import type { ActionInstance } from '../../src/shared/types.ts';
import { ButtonAgentPanel } from './components/ButtonAgentPanel.tsx';
import { DeviceView, type Mode, type Slot } from './components/DeviceView.tsx';
import { Library } from './components/Library.tsx';
import { Inspector } from './components/Inspector.tsx';
import { EmptyPageStarter, PagesBar } from './components/PagesBar.tsx';
import { NeoOptions, touchLabels } from './components/NeoOptions.tsx';
import { TopBar } from './components/TopBar.tsx';
import { Drawer } from './components/Drawer.tsx';
import { Icon } from './components/Icon.tsx';
import { PermissionBanner } from './components/PermissionBanner.tsx';
import { ActionComposer } from './components/ActionComposer.tsx';
import { actionSummary, validateActionSetup } from '../../src/shared/action-setup.ts';
import { actionCategory, actionChoices, choiceAppearance, isOneStepChoice, type ActionChoice } from '../../src/shared/action-presets.ts';
import { ConfirmFolderRemoval } from './components/ConfirmFolderRemoval.tsx';
import { InstalledAppsList } from './components/Fields.tsx';
import { copyActionClipboard, type ActionClipboard } from '../../src/shared/action-clipboard.ts';
import { isNative, native, nativeContextMenu, useMenuCommand, useNativeState } from './native.ts';

let clipboard: ActionClipboard | null = null;

export function App() {
  const { state, connected, wasConnected } = useAppState();
  const nativeState = useNativeState();
  const toasts = useToasts();
  // Start on a real (USB) device when one is connected; the user can still switch to a simulator.
  const [deviceId, setDeviceId] = useState<string | null>(()=>localGet('sdp.device'));
  const [mode, setMode] = useState<Mode>(() => (localGet('sdp.mode') as Mode) || 'edit');
  const [selected, setSelected] = useState<Slot | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const [revealTarget,setRevealTarget]=useState<ButtonTarget | null>(null);
  const [menu, setMenu] = useState<{ slot: Slot; x: number; y: number } | null>(null);
  const [draft, setDraft] = useState<{ choice: ActionChoice; slot: Slot; instance?: ActionInstance; focusAppearance?: boolean; recordShortcut?: boolean } | null>(null);
  const adding = useRef(false);
  const pageRef = useRef<string | undefined>(undefined);
  const [removal, setRemoval] = useState<{ slot: Slot; profileId: string; pageId: string; actionId: string; name: string } | null>(null);

  const device = state?.devices.find((d) => d.id === deviceId) ?? state?.devices.find((d) => d.kind === 'usb') ?? state?.devices[0];
  const profile = device ? state?.config.profiles.find((p) => p.id === device.profileId) : undefined;
  const page = profile && device ? profile.pages[device.pageId] : undefined;
  const catalog = useMemo(() => new Map((state?.catalog ?? []).map((m) => [m.type, m])), [state?.catalog]);
  pageRef.current = page?.id;
  const instance = selected && page ? (selected.kind === 'key' ? page.keys[selected.index] : page.dials[selected.index]) : null;
  const selectedMeta = instance && catalog.get(instance.type);
  const openBrowser = () => {
    setMode('edit');
    setBrowsing(true);
    requestAnimationFrame(() => document.getElementById('action-search')?.focus());
  };
  const closeBrowser = () => {
    setBrowsing(false);
    requestAnimationFrame(() => document.getElementById('browse-actions')?.focus());
  };
  const selectSlot = (slot: Slot | null) => {
    setSelected(slot);
    setBrowsing(false);
    if (slot) requestAnimationFrame(() => {
      const emptyKey = slot.kind === 'key' && !slotInst(slot);
      const prompt = emptyKey ? document.getElementById('agent-instruction') : null;
      if (prompt) prompt.focus();
      else document.getElementById('key-workspace-title')?.focus({ preventScroll: true });
    });
  };

  useEffect(() => { localSet('sdp.mode', mode); }, [mode]);
  useEffect(() => {
    if (device) localSet('sdp.device', device.id);
  }, [device?.id]);
  useEffect(() => { setSelected(null); setBrowsing(false); setDraft(null); setRemoval(null); }, [device?.pageId, device?.id, device?.profileId]);
  useEffect(()=>{if(revealTarget && device?.pageId===revealTarget.pageId && device?.profileId===revealTarget.profileId){setSelected({kind:revealTarget.kind,index:revealTarget.index});setRevealTarget(null);}},[revealTarget,device?.pageId,device?.profileId]);

  const base = (s: Slot) => ({ profileId: profile!.id, pageId: page!.id, kind: s.kind, index: s.index });
  const slotInst = (s: Slot) => (s.kind === 'key' ? page?.keys[s.index] : page?.dials[s.index]);
  const copy = (s: Slot) => {
    const i = slotInst(s);
    if (i) {
      try { clipboard = copyActionClipboard(i, profile!.pages); toast('Copied'); return true; }
      catch (e) { toast((e as Error).message, 'error'); return false; }
    }
    return false;
  };
  const paste = (s: Slot) => {
    if (!clipboard) return toast('Nothing to paste');
    if (slotInst(s)?.type === 'sd.folder') return toast('Remove the destination folder first, or paste onto another button.');
    void act('slots.paste', { ...base(s), ...clipboard });
  };
  const clear = (s: Slot) => {
    const inst = slotInst(s);
    if (!inst) return;
    if (inst.type === 'sd.folder' && inst.settings.folderId) setRemoval({ slot: s, profileId: profile!.id, pageId: page!.id, actionId: inst.id, name: inst.appearance.title || 'Folder' });
    else void act('slots.clear', { ...base(s), expectedActionId: inst.id });
  };
  const slotLabel = (s: Slot) => `${s.kind === 'key' ? 'Key' : 'Dial'} ${s.index + 1}`;
  /** Where a choice would go, and whether it can be added without the setup dialog. */
  const planAdd = (choice: ActionChoice, target?: Slot) => {
    const meta = catalog.get(choice.type);
    if (!meta || !page) return null;
    const candidate = target ?? selected;
    const kind: Slot['kind'] = candidate && meta.controllers.includes(candidate.kind) ? candidate.kind : meta.controllers.includes('key') ? 'key' : 'dial';
    const list = kind === 'key' ? page.keys : page.dials;
    const empty = list.findIndex((a) => !a);
    const slot: Slot | null = candidate && candidate.kind === kind ? candidate : empty >= 0 ? { kind, index: empty } : null;
    const quick = !!slot && !list[slot.index] && isOneStepChoice(choice, meta, kind, (t) => catalog.get(t));
    return { meta, kind, list, slot, quick };
  };
  const chooseAction = (choice: ActionChoice, target?: Slot, opts: { customize?: boolean; recordShortcut?: boolean } = {}) => {
    const plan = planAdd(choice, target);
    if (!plan || !page || !profile) return;
    const { meta, kind, slot } = plan;
    // Complete presets can be assigned immediately to an empty slot.
    if (!opts.customize && plan.quick && slot) {
      if (adding.current) return; // a double-click must not stack two adds on one button
      adding.current = true;
      const settings = { ...structuredClone(meta.defaults), ...structuredClone(choice.settings) };
      const where = base(slot);
      const pageId = page.id;
      const appearance = choiceAppearance(choice, meta);
      // Open-app presets get the app's real icon when it is installed.
      const icon = choice.type === 'system.open' ? client.rpc<string | null>('host.appIcon', { app: settings.path }).catch(() => null) : Promise.resolve(null);
      void icon.then((id) => {
        if (id) appearance.icon = { kind: 'image', id };
        // expectEmpty: if something landed on this button meanwhile, nothing is overwritten.
        return client.rpc<string>('slots.assign', { ...where, type: choice.type, settings, appearance, configured: true, expectEmpty: true });
      }).then((id) => {
        // Show the action we just installed.
        if (pageRef.current === pageId) {
          selectSlot({ kind, index: slot.index });
        }
        toast(`${choice.name} added to ${slotLabel(slot)}`, 'info', { label: 'Undo', run: () => client.rpc('slots.clear', { ...where, expectedActionId: id }).catch((e: Error) => toast(e.message, 'error')) });
      }).catch((e: Error) => toast(e.message, 'error')).finally(() => { adding.current = false; });
      return;
    }
    setDraft({ choice, slot: slot ?? { kind, index: 0 }, recordShortcut: opts.recordShortcut });
  };
  const configureAction = (slot: Slot | null, focusAppearance = false) => {
    if (!slot) return false;
    const inst = slotInst(slot);
    const meta = inst && catalog.get(inst.type);
    if (!inst || !meta || meta.category === 'Hidden') return false;
    setDraft({ slot, focusAppearance, instance: structuredClone(inst), choice: { id: `edit:${inst.id}`, type: inst.type, name: meta.name, description: meta.description, category: actionCategory(meta), icon: meta.icon, color: meta.color, settings: structuredClone(inst.settings), appearance: structuredClone(inst.appearance) } });
    return true;
  };

  // The app's View menu. In the browser these never fire; dialogs keep their focus like the keyboard shortcuts do.
  const fromMenu = (fn: () => void) => () => { if (!draft && !removal) fn(); };
  useMenuCommand('mode.edit', fromMenu(() => setMode('edit')));
  useMenuCommand('mode.use', fromMenu(() => setMode('use')));
  useMenuCommand('actions.browse', fromMenu(openBrowser));
  useMenuCommand('slot.configure', fromMenu(() => { if (mode === 'edit') configureAction(selected, true); }));

  /** Right-click on a key or dial in the app: the system menu instead of the in-page one. */
  const showNativeMenu = async (s: Slot) => {
    if (mode !== 'edit' || !device) return;
    const filled = !!slotInst(s);
    const choice = await nativeContextMenu([
      { id: 'copy', label: 'Copy', enabled: filled },
      { id: 'paste', label: 'Paste', enabled: !!clipboard },
      { id: 'test', label: 'Test', enabled: filled },
      { separator: true },
      { id: 'clear', label: 'Clear', enabled: filled },
    ]);
    if (choice === 'copy') copy(s);
    else if (choice === 'paste') paste(s);
    else if (choice === 'test') void act('slots.test', { deviceId: device.id, kind: s.kind, index: s.index });
    else if (choice === 'clear') clear(s);
  };

  // Shortcuts
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (draft || removal) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openBrowser(); return; }
      const mod = e.metaKey || e.ctrlKey;
      // ⌘Z undoes the last one-click add / layout fill while its toast is showing.
      const field = (e.target instanceof Element ? e.target.closest('input,textarea,select,[contenteditable]') : null) as HTMLInputElement | null;
      if (mod && !e.shiftKey && e.key.toLowerCase() === 'z' && (!field || (field.id === 'action-search' && !field.value)) && runLatestToastAction()) { e.preventDefault(); return; }
      if (e.key === 'Escape' && browsing && !e.defaultPrevented) { closeBrowser(); return; }
      if (!field && !e.defaultPrevented && mode === 'edit' && e.metaKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'i' && configureAction(selected, true)) {
        e.preventDefault();
        return;
      }
      if (field || e.defaultPrevented || (e.target instanceof Element && e.target.closest('button:not(.key):not(.knob),summary'))) return;
      if (!mod && e.key.toLowerCase() === 'e') setMode('edit');
      else if (!mod && e.key.toLowerCase() === 'u') setMode('use');
      if (!selected || !page || mode !== 'edit') return;
      if (e.key === 'Backspace' || e.key === 'Delete') clear(selected);
      // Highlighted page text: leave ⌘C/⌘X/⌘V to the browser and the Edit menu.
      else if (mod && ['c', 'x', 'v'].includes(e.key) && window.getSelection()?.toString()) return;
      // preventDefault keeps the Edit menu's own Copy/Paste/Cut from running the same command again.
      else if (mod && e.key === 'c') { e.preventDefault(); copy(selected); }
      else if (mod && e.key === 'v') { e.preventDefault(); paste(selected); }
      else if (mod && e.key === 'x') {
        e.preventDefault();
        if (copy(selected)) clear(selected);
      } else if (e.key === 'Escape') setSelected(null);
      else if (e.key.startsWith('Arrow') && selected.kind === 'key' && device) {
        const c = device.columns;
        const n = c * device.rows;
        const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowDown' ? c : -c;
        const next = selected.index + d;
        if (next >= 0 && next < n) setSelected({ kind: 'key', index: next });
        else if (e.key === 'ArrowDown' && device.encoders) setSelected({ kind: 'dial', index: Math.min(device.encoders - 1, selected.index % c) });
        e.preventDefault();
      } else if (e.key.startsWith('Arrow') && selected.kind === 'dial' && device) {
        if (e.key === 'ArrowUp') setSelected({ kind: 'key', index: (device.rows - 1) * device.columns + Math.min(selected.index, device.columns - 1) });
        else if (e.key === 'ArrowRight') setSelected({ kind: 'dial', index: Math.min(device.encoders - 1, selected.index + 1) });
        else if (e.key === 'ArrowLeft') setSelected({ kind: 'dial', index: Math.max(0, selected.index - 1) });
        e.preventDefault();
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  });

  // Edit ▸ Copy/Cut/Paste clicked with the mouse arrive as clipboard events: apply them to the selected key.
  useEffect(() => {
    const onClipboard = (e: ClipboardEvent) => {
      if (draft || removal || mode !== 'edit' || !selected || !page) return;
      const target = e.target instanceof Element ? e.target : null;
      if (target?.closest('input,textarea,select,[contenteditable],button:not(.key):not(.knob),summary')) return;
      if (window.getSelection()?.toString()) return; // real text selection: let the browser handle it
      e.preventDefault();
      if (e.type === 'copy') copy(selected);
      else if (e.type === 'paste') paste(selected);
      else if (copy(selected)) clear(selected);
    };
    const types = ['copy', 'cut', 'paste'] as const;
    for (const t of types) document.addEventListener(t, onClipboard);
    return () => { for (const t of types) document.removeEventListener(t, onClipboard); };
  });

  if (!state) {
    return (
      <div className="boot">
        <p>{connected ? 'Loading…' : isNative ? 'Starting StreamDeckPlus…' : 'Open the editor using the link printed by StreamDeckPlus.'}</p>
      </div>
    );
  }

  const target = selected && profile && page ? { profileId: profile.id, pageId: page.id, ...selected } : null;
  const title = instance?.appearance.title?.trim() || selectedMeta?.name || (instance ? 'Imported action' : undefined);
  const configure = selectedMeta && selectedMeta.category !== 'Hidden' ? () => configureAction(selected) : undefined;
  const quickActions = !state.platform.localOnly && !instance && selected?.kind === 'key'
    ? actionChoices(state.catalog).filter(choice => ['system.open', 'system.hotkey'].includes(choice.id))
    : [];
  const setupIssue = state.platform.localOnly && instance && !isLocalAction(instance) ? externalActionMessage
    : instance && selected && selectedMeta
    ? validateActionSetup(selectedMeta, instance.settings, selected.kind, type => catalog.get(type))[0]
    : undefined;
  const designBlocked = instance?.type === 'sd.folder' || selectedMeta?.category === 'Hidden' || selected?.kind === 'dial'
    ? 'Use Configure or Browse actions for this control.' : undefined;
  const actionDescription = instance && selectedMeta
    ? instance.type === 'system.script' ? 'Runs a local script when pressed.' : actionSummary(selectedMeta, instance.settings, selected?.kind)
    : undefined;
  const reveal = async (where: ButtonTarget) => {
    const targetProfile = state.config.profiles.find(item => item.id === where.profileId);
    if (!targetProfile?.pages[where.pageId]) { toast('This key is no longer on the deck.'); return; }
    const targetDevice = state.devices.find(item => item.profileId === where.profileId)
      ?? state.devices.find(item => item.modelId === targetProfile.modelId);
    if (!targetDevice) { toast('Connect a compatible device to open this key.'); return; }
    try {
      setDeviceId(targetDevice.id);
      if (targetDevice.profileId !== where.profileId) await client.rpc('session.setProfile', { deviceId: targetDevice.id, profileId: where.profileId });
      if (targetDevice.pageId !== where.pageId) await client.rpc('session.setPage', { deviceId: targetDevice.id, pageId: where.pageId });
      setBrowsing(false);
      setRevealTarget(where);
    } catch (e) { toast((e as Error).message, 'error'); }
  };

  return (
    <div className={`app studio-app mode-${mode}`}>
      <TopBar state={state} device={device} profile={profile} mode={mode} setMode={setMode} selectDevice={setDeviceId} connected={connected} />
      {device?.kind !== 'sim' && <PermissionBanner state={state} />}
      <main className="studio-work">
        <div className={`studio-layout ${mode === 'use' || !device ? 'studio-solo' : ''}`}>
          {device && profile ? (
            <section className="deck-studio" aria-label="Your deck">
              <div className="deck-studio-header">
                <div><p className="deck-kicker">{device.kind === 'sim' ? 'Simulator' : 'Connected via USB'}</p><h2>{device.modelName}</h2></div>
                {mode === 'edit' && selected && <button className="ghost studio-jump" onClick={() => document.getElementById('key-workspace')?.scrollIntoView({ block: 'nearest' })}>Go to {slotLabel(selected).toLowerCase()} <Icon name="arrow-down" size={14}/></button>}
              </div>
              <div className="deck-stage" data-dials={device.encoders > 0}>
                <DeviceView
                  device={device} page={page} catalog={catalog} mode={mode}
                  selected={mode === 'edit' ? selected : null} onSelect={selectSlot}
                  onConfigure={slot => configureAction(slot, true)}
                  onDropAction={(slot, type) => {
                    const choice = actionChoices(state.catalog).find(item => item.id === type || item.id === item.type && item.type === type);
                    if (choice && catalog.get(choice.type)?.controllers.includes(slot.kind)) { selectSlot(slot); chooseAction(choice, slot); }
                    else if (choice) toast('Select a compatible key or dial for this action.');
                  }}
                  onMoveSlot={async (from, to, cp) => {
                    if (from.kind === to.kind && from.index === to.index) return;
                    await act('slots.move', { profileId: profile.id, from: { pageId: page!.id, ...from }, to: { pageId: page!.id, ...to }, copy: cp });
                    selectSlot(to);
                  }}
                  onContext={(slot, x, y) => isNative ? void showNativeMenu(slot) : setMenu({ slot, x, y })}
                  touchLabels={touchLabels(profile)}
                />
              </div>
              {isNative && !state.devices.some((d) => d.kind === 'usb') && (state.platform.hidError || nativeState?.elgato.running)
                ? <DeckAlert hidError={!!state.platform.hidError} elgato={nativeState?.elgato} /> : null}
              <PagesBar device={device} profile={profile} />
              {mode === 'edit' && device.modelId === 'neo' && <details className="deck-options"><summary>Deck controls</summary><NeoOptions device={device} profile={profile} /></details>}
              {mode === 'edit' && page && [...page.keys, ...page.dials].every(action => !action) &&
                <details className="deck-options"><summary>Start from a layout</summary><EmptyPageStarter profile={profile} pageId={page.id} /></details>}
            </section>
          ) : isNative ? (
            <NoDevice hidError={!!state.platform.hidError} elgato={nativeState?.elgato} onTrySimulator={() => act('sim.add', { modelId: 'neo' }).then(id => id && setDeviceId(id))} />
          ) : (
            <section className="studio-no-device">
              <Icon name="usb" size={30}/>
              <h1>Connect a Stream Deck</h1>
              <p>Plug in your deck to start assigning keys, or try a simulator.</p>
              <div className="studio-action-bar">
                <button className="primary" onClick={() => act('sim.add', { modelId: 'neo' }).then(id => id && setDeviceId(id))}>Try Neo simulator</button>
                <button className="secondary" onClick={() => act('sim.add', { modelId: 'plus' }).then(id => id && setDeviceId(id))}>Try Plus simulator</button>
              </div>
            </section>
          )}
          {mode === 'edit' && device && profile && page && (
            <ButtonAgentPanel target={target} title={title} actionId={instance?.id} icon={instance?.appearance.icon?.kind === 'lucide' ? instance.appearance.icon.name : selectedMeta?.icon}
              actionDescription={actionDescription}
              setupIssue={setupIssue} designBlocked={designBlocked}
              deviceId={device.id} canExecute={device.canExecute ?? state.platform.canExecute} simulator={device.kind === 'sim'}
              browsing={browsing} onBrowse={openBrowser} onCloseBrowse={closeBrowser} onReveal={reveal}
              quickActions={quickActions.map(choice => ({
                label: choice.type === 'system.open' ? 'Open an app…' : 'Keyboard shortcut…',
                icon: choice.icon,
                choose: () => chooseAction(choice, undefined, { recordShortcut: choice.type === 'system.hotkey' }),
              }))}
              onConfigure={configure}
              onOpenFolder={instance?.type === 'sd.folder' && instance.settings.folderId
                ? () => void act('session.setPage', { deviceId: device.id, pageId: instance.settings.folderId }) : undefined}
              library={<Library catalog={state.platform.localOnly ? state.catalog.filter((meta) => canConfigureLocalAction(meta.type)) : state.catalog} localOnly={state.platform.localOnly} hasDials={device.encoders > 0} target={selected}
                onChoose={(choice, options) => chooseAction(choice, undefined, options)} isQuick={choice => !!planAdd(choice)?.quick}/>}
              advanced={instance && selected ? <Inspector deviceId={device.id} profile={profile} profiles={state.config.profiles}
                pageId={page.id} slot={selected} instance={instance} catalog={catalog}
                onOpenFolder={id => act('session.setPage', { deviceId: device.id, pageId: id })}
                onBrowseActions={openBrowser} onRemove={() => clear(selected)} onConfigure={() => configureAction(selected)}/> : undefined}
            />
          )}
        </div>
      </main>
      <Drawer />
      <InstalledAppsList />
      {removal ? <ConfirmFolderRemoval name={removal.name} onClose={() => setRemoval(null)} onConfirm={async () => {
        await client.rpc('slots.clear', { profileId: removal.profileId, pageId: removal.pageId, ...removal.slot, expectedActionId: removal.actionId, deleteFolder: true });
        toast('Folder removed');
      }} /> : null}
      {draft && device && profile && page ? <ActionComposer key={`${draft.choice.id}:${device.id}:${page.id}`} choice={draft.choice} instance={draft.instance} focusAppearance={draft.focusAppearance} recordShortcut={draft.recordShortcut} meta={catalog.get(draft.choice.type)!} profile={profile} profiles={state.config.profiles} pageId={page.id} catalog={catalog} initialSlot={draft.slot} onClose={() => setDraft(null)} onSave={async (slot, settings, appearance, replaceFolder) => {
        if (draft.instance) await client.rpc('slots.update', { ...base(slot), settings, appearance, expectedActionId: draft.instance.id });
        else await client.rpc('slots.assign', { ...base(slot), type: draft.choice.type, settings, appearance, replaceFolder, configured: true, expectedActionId: slotInst(slot)?.id ?? null });
        selectSlot(slot); setDraft(null); toast(`${draft.instance ? 'Changes saved on' : 'Ready on'} ${slotLabel(slot)}`);
      }} /> : null}
      {menu ? (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            { label: 'Copy', icon: 'copy', hint: '⌘C', run: () => copy(menu.slot), disabled: !slotInst(menu.slot) },
            { label: 'Paste', icon: 'clipboard-paste', hint: '⌘V', run: () => paste(menu.slot), disabled: !clipboard },
            { label: 'Test', icon: 'play', run: () => act('slots.test', { deviceId: device!.id, kind: menu.slot.kind, index: menu.slot.index }), disabled: !slotInst(menu.slot) },
            { label: 'Clear', icon: 'trash-2', hint: '⌫', run: () => clear(menu.slot), disabled: !slotInst(menu.slot), danger: true },
          ]}
        />
      ) : null}
      {isNative && wasConnected && !connected ? (
        <div className="reconnect-overlay" role="status" aria-live="polite">
          <div className="reconnect-card"><span className="sdp-spinner" aria-hidden /> Reconnecting…</div>
        </div>
      ) : null}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            <span>{t.msg}</span>
            {t.action ? <button className="toast-action" onClick={() => { dismissToast(t.id); void t.action!.run(); }}>{t.action.label}</button> : null}
          </div>
        ))}
      </div>
    </div>
  );
}

/** The app's empty state: no deck and no simulator. Updates live as decks come and go. */
/** While a simulator is open: why the physical deck is missing, and the one action that fixes it. */
function DeckAlert({ hidError, elgato }: { hidError: boolean; elgato?: { running: boolean; name?: string; reopened?: boolean } }) {
  const [quitting, setQuitting] = useState(false);
  const holder = elgato?.name || 'Elgato Stream Deck';
  return (
    <div className="deck-alert" role="status" aria-live="polite">
      <Icon name={hidError ? 'triangle-alert' : 'usb'} size={15}/>
      <span>{hidError ? "Device support didn't load. Reinstall StreamDeckPlus to use your deck."
        : elgato?.reopened ? 'Stream Deck reopened. Turn off its Open at Login, then try again.'
        : `${holder} is using your deck.`}</span>
      {!hidError && elgato?.running && !elgato.reopened ? (
        <button className="secondary" disabled={quitting} onClick={async () => {
          setQuitting(true);
          try { await native!.command('elgato.quit'); } finally { setQuitting(false); }
        }}>{quitting ? 'Quitting…' : 'Quit It and Connect'}</button>
      ) : null}
    </div>
  );
}

function NoDevice({ hidError, elgato, onTrySimulator }: { hidError: boolean; elgato?: { running: boolean; name?: string; reopened?: boolean }; onTrySimulator(): void }) {
  const [quitting, setQuitting] = useState(false);
  const quitElgato = async () => {
    setQuitting(true);
    try {
      const ok = await native!.command<boolean>('elgato.quit');
      if (ok === false) toast("It didn't quit. Quit it from its menu bar icon, then plug your deck in again.", 'error');
    } catch { toast("It didn't quit. Quit it from its menu bar icon, then plug your deck in again.", 'error'); }
    finally { setQuitting(false); }
  };
  const holder = elgato?.name || 'Elgato Stream Deck';
  return (
    <section className="studio-no-device native-no-device" aria-labelledby="no-device-title">
      <Icon name={hidError ? 'triangle-alert' : 'usb'} size={30}/>
      <h1 id="no-device-title">{hidError ? "Device support didn't load" : 'Plug in your Stream Deck'}</h1>
      <div role="status" aria-live="polite">
        {hidError ? (
          <p>Reinstall StreamDeckPlus to use your deck.</p>
        ) : elgato?.running ? (
          <>
            <p>{elgato.reopened ? 'Stream Deck reopened. Turn off its Open at Login, then try again.' : `${holder} is using your deck.`}</p>
            <div className="studio-action-bar">
              <button className="primary" disabled={quitting} onClick={() => void quitElgato()}>{quitting ? 'Quitting…' : 'Quit It and Connect'}</button>
            </div>
          </>
        ) : (
          <p>It shows up here as soon as you connect it. To try without a deck, open Device ▸ Simulators.</p>
        )}
      </div>
      {!hidError && !elgato?.running ? <button className="link" onClick={onTrySimulator}>Try without a deck</button> : null}
    </section>
  );
}

function ContextMenu(p: { x: number; y: number; onClose(): void; items: { label: string; icon: string; hint?: string; run(): unknown; disabled?: boolean; danger?: boolean }[] }) {
  useEffect(() => {
    const h = () => p.onClose();
    window.addEventListener('mousedown', h);
    window.addEventListener('blur', h);
    return () => {
      window.removeEventListener('mousedown', h);
      window.removeEventListener('blur', h);
    };
  });
  return (
    <div className="ctx menu" style={{ left: Math.min(p.x, innerWidth - 200), top: Math.min(p.y, innerHeight - 180) }} onMouseDown={(e) => e.stopPropagation()}>
      {p.items.map((i) => (
        <button
          key={i.label}
          className={`menu-item ${i.danger ? 'danger' : ''}`}
          disabled={i.disabled}
          onClick={() => {
            p.onClose();
            void i.run();
          }}
        >
          <Icon name={i.icon} size={14} />
          <span className="grow">{i.label}</span>
          {i.hint ? <kbd>{i.hint}</kbd> : null}
        </button>
      ))}
    </div>
  );
}

function localGet(k: string): string | null {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function localSet(k: string, v: string) {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* ignore */
  }
}
