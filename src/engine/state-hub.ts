// Reads computer state for state rules. Each thing (volume, an app's name…) is read at most once per
// interval and shared by every key on every device that uses it. Only what visible keys use is read.

import { STATE_SOURCE_MAP, type StateReading, type StateSourceId, type StateValue } from '../shared/state-rules.ts';
import type { Platform } from './platform.ts';

/** "appRunning:Zoom" → ['appRunning', 'Zoom']. Unknown sources are rejected. */
export function parseStateKey(key: string): { source: StateSourceId; arg?: string } {
  const i = key.indexOf(':');
  const source = (i < 0 ? key : key.slice(0, i)) as StateSourceId;
  const meta = STATE_SOURCE_MAP.get(source);
  if (!meta) throw new Error(`Unknown state ${source}`);
  const arg = i < 0 ? undefined : key.slice(i + 1);
  if (!!meta.arg !== (arg !== undefined) || (arg !== undefined && (!arg.trim() || arg.length > 100))) throw new Error(`Invalid state ${key}`);
  return { source, arg };
}

export class StateHub {
  /** Last known value per state key. A failed read keeps it, like the volume icon does. */
  readonly values = new Map<string, StateValue>();
  private readings = new Map<string, StateReading>();
  private queue: Promise<unknown> = Promise.resolve();
  private platform: () => Platform;

  constructor(platform: () => Platform) {
    this.platform = platform;
  }

  /** Read the keys that are due (all of them with force). Resolves with the keys whose value changed. */
  refresh(keys: Iterable<string>, force = false): Promise<Set<string>> {
    const wanted = [...new Set(keys)];
    // One read at a time: overlapping ticks from several devices find nothing due and return at once.
    const next = this.queue.then(() => this.read(wanted, force));
    this.queue = next.catch(() => {});
    return next;
  }

  reading(key: string): StateReading | undefined {
    return this.readings.get(key);
  }

  /** Forget everything (dry run was toggled: the values came from another platform). */
  reset(): void {
    this.values.clear();
    this.readings.clear();
  }

  private async read(keys: string[], force: boolean): Promise<Set<string>> {
    const platform = this.platform();
    const now = Date.now();
    const due = keys.filter((k) => {
      let interval: number;
      try { interval = STATE_SOURCE_MAP.get(parseStateKey(k).source)!.intervalMs; } catch { return false; }
      return force || now - (this.readings.get(k)?.at ?? 0) >= interval;
    });
    const changed = new Set<string>();
    let audioRead = false;
    await Promise.all(due.map(async (key) => {
      const { source, arg } = parseStateKey(key);
      const audio = source === 'volume' || source === 'muted';
      if (audio && audioRead) return;
      if (audio) audioRead = true;
      try {
        if (audio) {
          const sample = await platform.getVolume();
          if (platform !== this.platform()) return;
          this.set('volume', sample.volume, changed);
          this.set('muted', sample.muted, changed);
          return;
        }
        const value = await platform.readState(source, arg);
        if (platform !== this.platform()) return;
        this.set(key, value, changed);
      } catch (e) {
        if (platform !== this.platform()) return;
        for (const failed of audio ? ['volume', 'muted'] : [key]) {
          this.readings.set(failed, { value: this.values.get(failed), error: (e as Error).message, at: Date.now() });
        }
      }
    }));
    return changed;
  }

  private set(key: string, value: StateValue, changed: Set<string>): void {
    if (this.values.get(key) !== value) changed.add(key);
    this.values.set(key, value);
    this.readings.set(key, { value, at: Date.now() });
  }
}
