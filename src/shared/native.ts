// Desktop app contract shared by the Electron main process (electron/) and the editor UI (ui/src/native.ts).
// Types only. The browser editor never sees window.osbNative.

export type StartErrorKind = 'locked' | 'config-invalid' | 'port-in-use' | 'start-failed';

/** What windows see of the background service. */
export type ServicePhase =
  | { phase: 'starting' }
  | { phase: 'ready'; url: string }
  | { phase: 'restarting'; attempt: number }
  | { phase: 'fatal'; message: string }
  | { phase: 'error'; kind: StartErrorKind; message: string }
  | { phase: 'stopping' };

import type { AiPreference } from './button-agent.ts';

export type ThemePref = 'system' | 'light' | 'dark';

export interface Prefs {
  /** Stable editor port for this Mac, chosen on first launch. */
  port?: number;
  onboarded: boolean;
  openAtLogin: boolean;
  showInMenuBar: boolean;
  checkForUpdates: boolean;
  closeNoticeShown: boolean;
  model: string;
  /** Which AI designs buttons. Automatic: Claude Code, then Codex, then the API key. */
  aiProvider: AiPreference;
  theme: ThemePref;
  windowBounds?: { x: number; y: number; width: number; height: number };
}

export type PublicPrefs = Omit<Prefs, 'port' | 'windowBounds' | 'closeNoticeShown'>;
export type PrefKey = 'openAtLogin' | 'showInMenuBar' | 'checkForUpdates' | 'theme' | 'model' | 'aiProvider';

export type UpdateStatus =
  | { state: 'idle' }
  | { state: 'unavailable'; reason: string }
  | { state: 'checking' }
  | { state: 'current'; version: string }
  | { state: 'downloading'; percent: number; version: string }
  | { state: 'ready'; version: string }
  | { state: 'error'; message: string };

export interface ElgatoStatus { running: boolean; name?: string; reopened?: boolean }

/** Snapshot pushed to every app window. */
export interface NativeState {
  version: string;
  packaged: boolean;
  service: ServicePhase;
  prefs: PublicPrefs;
  ai: { hasKey: boolean; model: string; provider: AiPreference; secureStorage: boolean; keyNeedsReentry?: boolean };
  update: UpdateStatus;
  elgato: ElgatoStatus;
  dataDir: string;
}

/** Commands the main process accepts from windows (electron/main.ts `commands`). */
export type NativeCommand =
  | 'service.restart' | 'service.repair' | 'service.startFresh'
  | 'logs.show' | 'data.show' | 'licenses.show'
  | 'elgato.quit' | 'settings.open' | 'editor.open' | 'permissions.open'
  | 'update.check' | 'update.install' | 'ai.test' | 'diagnostics.copy' | 'onboarding.finish';

/** Menu commands sent to windows (electron/menu.ts). Settings tabs arrive as `settings.<tab>`. */
export type MenuCommand =
  | 'profile.new' | 'profile.import' | 'profile.export' | 'mode.edit' | 'mode.use'
  | 'actions.browse' | 'slot.configure' | 'activity.toggle' | 'device.reconnect' | `settings.${string}`;

export interface ContextMenuItem { id?: string; label?: string; enabled?: boolean; separator?: boolean }

/** window.osbNative, exposed by electron/preload.cjs. */
export interface NativeBridge {
  getState(): Promise<NativeState>;
  onState(fn: (state: NativeState) => void): () => void;
  onMenu(fn: (command: MenuCommand) => void): () => void;
  command<T = unknown>(name: NativeCommand, arg?: unknown): Promise<T>;
  setPref(key: PrefKey, value: unknown): Promise<NativeState>;
  setApiKey(key: string | null): Promise<NativeState>;
  contextMenu(items: ContextMenuItem[]): Promise<string | null>;
}
