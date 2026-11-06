// Data model shared by the server and the UI.

import type { StateRule } from './state-rules.ts';

export type IconRef =
  | { kind: 'lucide'; name: string }
  | { kind: 'image'; id: string }
  | { kind: 'emoji'; char: string }
  | { kind: 'none' };

export type TitleAlign = 'top' | 'middle' | 'bottom';

export interface Appearance {
  title?: string;
  showTitle?: boolean;
  titleColor?: string;
  titleSize?: number;
  titleAlign?: TitleAlign;
  icon?: IconRef;
  iconColor?: string;
  bg?: string;
  bgImage?: string | null;
}

export interface ActionInstance {
  id: string;
  type: string;
  settings: Record<string, unknown>;
  appearance: Appearance;
  /** Optional per-state appearance overrides (state 0 = default, 1 = "on"). */
  states?: Appearance[];
  /** Looks that follow the computer's state (muted, dark mode…). The first match wins. */
  stateRules?: StateRule[];
}

export interface Page {
  id: string;
  name: string;
  keys: (ActionInstance | null)[];
  dials: (ActionInstance | null)[];
  /** Folder pages have a parent and are not part of the top-level page rotation. */
  parentId?: string | null;
  touchBg?: string;
}

export interface Profile {
  id: string;
  name: string;
  modelId: string;
  pageOrder: string[];
  pages: Record<string, Page>;
  createdAt: number;
  source?: string;
  /** Stream Deck Neo: what the two touch points and the info bar do. */
  neo?: NeoOptions;
}

export type TouchPointMode = 'pages' | 'media' | 'volume' | 'spaces' | 'none';
export type InfoBarMode = 'clock' | 'page' | 'off';
export interface NeoOptions {
  touchPoints?: TouchPointMode;
  infoBar?: InfoBarMode;
}

export interface Settings {
  buttonAgent?: { enabled: boolean; provider: 'codex' | 'claude' };
  executeActions: boolean;
  pressFeedback: boolean;
  defaultBrightness: number;
  sleepDelay: number;
  autoSimulator: boolean;
  swipeChangesPages: boolean;
}

export interface Config {
  /** 2 = icons are only stored when the user picks one. */
  version: number;
  profiles: Profile[];
  /** device serial (or "sim:<model>") -> profile id */
  deviceProfiles: Record<string, string>;
  settings: Settings;
}

export interface Hotkey {
  key: string;
  cmd?: boolean;
  ctrl?: boolean;
  opt?: boolean;
  shift?: boolean;
}

// ---- Action catalog metadata -------------------------------------------------------------------

export type FieldType =
  | 'text'
  | 'textarea'
  | 'number'
  | 'slider'
  | 'select'
  | 'toggle'
  | 'hotkey'
  | 'page'
  | 'folder'
  | 'profile'
  | 'steps';

export interface Field {
  key: string;
  label: string;
  type: FieldType;
  options?: { value: string; label: string }[];
  placeholder?: string;
  min?: number;
  max?: number;
  step?: number;
  help?: string;
  /** A configured action cannot be saved until this value is present. */
  required?: boolean;
  /** Only show for these controllers. */
  controllers?: Controller[];
  /** Offer the native macOS chooser next to a text field. */
  browse?: 'folder' | 'file' | 'app';
  /** Offer installed apps as suggestions while typing. */
  suggest?: 'apps';
}

export type Controller = 'key' | 'dial';

export interface ActionMeta {
  type: string;
  name: string;
  category: string;
  description: string;
  icon: string;
  controllers: Controller[];
  fields: Field[];
  defaults: Record<string, unknown>;
  /** Accent used on the touch strip and in the library. */
  color: string;
  /** Elgato action UUID(s) this maps from when importing profiles. */
  elgato?: string[];
}

// ---- Wire protocol -----------------------------------------------------------------------------

export interface DeviceSummary {
  id: string;
  kind: 'usb' | 'sim';
  canExecute?: boolean;
  modelId: string;
  modelName: string;
  serial: string;
  firmware: string;
  path: string;
  brightness: number;
  sleepDelay: number;
  columns: number;
  rows: number;
  encoders: number;
  lcd: { width: number; height: number } | null;
  touchPoints: number;
  infoBar: { width: number; height: number } | null;
  touchPointColors?: string[];
  keyPx: number;
  profileId: string;
  pageId: string;
  /** Folder navigation stack (page ids). */
  stack: string[];
  sim?: { asleep: boolean; stats: { outputReports: number; featureReports: number; inputReports: number; bytesOut: number } };
}

export interface DiscoveredSummary {
  path: string;
  kind: 'usb' | 'sim';
  productId: number;
  modelName: string;
  supported: boolean;
  deviceId?: string;
  error?: string;
  serial?: string;
}

export interface AppState {
  config: Config;
  catalog: ActionMeta[];
  devices: DeviceSummary[];
  discovered: DiscoveredSummary[];
  platform: {
    os: string;
    hidAvailable: boolean;
    /** Why USB support failed to load (absent when USB is working or deliberately disabled). */
    hidError?: string;
    canExecute: boolean;
    localOnly?: boolean;
    host: string;
    permissions: { id: 'accessibility' | 'automation'; ok: boolean | null; label: string; detail: string }[];
  };
}

export interface HidLogEntry {
  t: number;
  deviceId: string;
  dir: 'out' | 'in' | 'feature';
  summary: string;
  hex: string;
}
