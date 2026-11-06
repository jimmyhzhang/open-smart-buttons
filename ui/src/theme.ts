import { useSyncExternalStore } from 'react';
import { native } from './native.ts';

export type Theme = 'system' | 'light' | 'dark';

export function savedTheme(): Theme {
  try {
    const t = localStorage.getItem('sdp.theme');
    return t === 'light' || t === 'dark' ? t : 'system';
  } catch { return 'system'; }
}

/** Applies a theme. `mirror` also saves it as the app's choice, so every window and the title bar follow. */
const listeners = new Set<() => void>();
let current: Theme = 'system';

/** The theme this window shows; re-renders when any window changes it. */
export function useTheme(): Theme {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => current);
}

export function applyTheme(t: Theme, mirror = true) {
  if (t === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  if (current !== t) { current = t; listeners.forEach((l) => l()); }
  try { localStorage.setItem('sdp.theme', t); } catch { /* per-browser preference only */ }
  // In the app, window chrome, menus and dialogs follow the same choice.
  if (mirror) void native?.setPref('theme', t).catch(() => {});
}

/** In the app, the saved choice in the main process wins and changes in any window reach all of them. */
export function followNativeTheme(): void {
  if (!native) return;
  const follow = (t: Theme) => { if (t !== current) applyTheme(t, false); };
  native.onState((s) => follow(s.prefs.theme));
  void native.getState().then((s) => follow(s.prefs.theme), () => {});
}
