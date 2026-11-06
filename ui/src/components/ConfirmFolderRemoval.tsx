import { useEffect, useId, useRef, useState } from 'react';
import { Icon } from './Icon.tsx';

/** All folder-removal entry points share this explicit, keyboard-accessible confirmation. */
export function ConfirmFolderRemoval(p: { name: string; onClose(): void; onConfirm(): Promise<void> }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    dialog.current?.querySelector<HTMLButtonElement>('[data-cancel]')?.focus();
    return () => previous?.focus();
  }, []);
  const confirm = async () => {
    setBusy(true); setError('');
    try { await p.onConfirm(); p.onClose(); }
    catch (e) { setError((e as Error).message); setBusy(false); }
  };
  return <dialog className="confirm-folder" ref={dialog} aria-labelledby={titleId} aria-describedby={descriptionId} onCancel={(e) => { e.preventDefault(); if (!busy) p.onClose(); }}>
    <div className="confirm-folder-icon"><Icon name="folder-minus" size={24} /></div>
    <h2 id={titleId}>Remove this folder?</h2>
    <p id={descriptionId}>“{p.name}” and all of its pages and buttons will be removed. This can’t be undone.</p>
    {error ? <p className="setup-errors" role="alert">{error}</p> : null}
    <footer><button className="secondary" data-cancel disabled={busy} onClick={p.onClose}>Keep folder</button><button className="primary destructive" disabled={busy} onClick={() => void confirm()}>{busy ? 'Removing…' : 'Remove folder'}</button></footer>
  </dialog>;
}
