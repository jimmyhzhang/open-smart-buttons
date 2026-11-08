/** Copy only harmless UI preferences; launch credentials always come from the current service. */
export function migrateBrowserPreferences(storage?: Pick<Storage, 'getItem' | 'setItem'>): void {
  try {
    const target = storage ?? localStorage;
    for (const key of ['theme', 'mode', 'device', 'settings.tab']) {
      const current = `osb.${key}`;
      const legacy = `sdp.${key}`;
      if (target.getItem(current) === null) {
        const value = target.getItem(legacy);
        if (value !== null) target.setItem(current, value);
      }
    }
  } catch { /* Storage can be unavailable in a restricted browser. */ }
}
