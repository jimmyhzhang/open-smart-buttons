// The desktop app bridge. In the browser editor `native` is null and every helper is a no-op, so the
// same UI serves both. Running inside the app adds `html.electron` for native styling.

import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { MenuCommand, NativeBridge, NativeState } from '../../src/shared/native.ts';

export const native: NativeBridge | null = (globalThis as { sdpNative?: NativeBridge }).sdpNative ?? null;
export const isNative = native !== null;

/** Which window this page is: the editor, or the app's Settings and onboarding windows. */
export type View = 'editor' | 'settings' | 'onboarding';
export const view: View = (() => {
  const v = new URLSearchParams(location.search).get('view');
  return isNative && (v === 'settings' || v === 'onboarding') ? v : 'editor';
})();

if (isNative) document.documentElement.classList.add('electron', `view-${view}`);

let state: NativeState | null = null;
const listeners = new Set<() => void>();
const set = (next: NativeState) => { state = next; listeners.forEach((l) => l()); };
if (native) {
  native.onState(set);
  void native.getState().then(set, () => {});
}

/** Live app state (service phase, preferences, AI key presence, updates); null in the browser. */
export function useNativeState(): NativeState | null {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => state);
}

export function updateNativeState(next: NativeState): void {
  set(next);
}

const menuHandlers = new Map<MenuCommand, Set<() => void>>();
// A command can arrive before React has subscribed (the menu opened this window). Keep it briefly.
const pendingMenu: { command: MenuCommand; at: number }[] = [];
native?.onMenu((command) => {
  const handlers = menuHandlers.get(command);
  if (handlers?.size) handlers.forEach((fn) => fn());
  else pendingMenu.push({ command, at: Date.now() });
});

/** Runs `fn` when the app menu sends `command`. The latest `fn` is used without resubscribing. */
export function useMenuCommand(command: MenuCommand, fn: () => void): void {
  const latest = useRef(fn);
  latest.current = fn;
  useEffect(() => {
    if (!native) return;
    const run = () => latest.current();
    let handlers = menuHandlers.get(command);
    if (!handlers) menuHandlers.set(command, (handlers = new Set()));
    handlers.add(run);
    for (let i = pendingMenu.length - 1; i >= 0; i--) {
      const p = pendingMenu[i]!;
      if (p.command !== command) continue;
      pendingMenu.splice(i, 1);
      if (Date.now() - p.at < 10_000) queueMicrotask(run);
    }
    return () => { handlers!.delete(run); };
  }, [command]);
}

/** Shows a native context menu and resolves with the chosen id, or null if dismissed or in the browser. */
export async function nativeContextMenu(items: { id?: string; label?: string; enabled?: boolean; separator?: boolean }[]): Promise<string | null> {
  if (!native) return null;
  try { return await native.contextMenu(items); } catch { return null; }
}
