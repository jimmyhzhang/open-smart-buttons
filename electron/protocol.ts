// Messages between the main process and the service utility process, and the state the main process
// shares with renderers. Types only: erased at runtime.

import type { StartErrorKind as ServiceStartErrorKind } from '../src/shared/native.ts';

export interface InferenceConfig { apiKey?: string | null; model?: string | null }

export interface StartRequest {
  type: 'start';
  dataDir: string;
  port: number;
  token: string;
  browserToken: string;
  appName: string;
  sim: boolean;
  inference: InferenceConfig;
}

export type HostMessage =
  | StartRequest
  | { type: 'stop' }
  | { type: 'setInference'; inference: InferenceConfig }
  | { type: 'repair'; id: number; dataDir: string; stamp: string }
  | { type: 'testInference'; id: number };

export type ServiceMessage =
  | { type: 'hello'; pid: number }
  | { type: 'ready'; port: number; hidAvailable: boolean; canExecute: boolean }
  | { type: 'start-error'; kind: ServiceStartErrorKind; message: string }
  | { type: 'stopped'; saved: boolean }
  | { type: 'repaired'; id: number; ok: true; original: string; profiles: number; changes: number }
  | { type: 'repaired'; id: number; ok: false; message: string }
  | { type: 'inferenceTested'; id: number; ok: boolean; message: string };

export type { ServicePhase, Prefs, UpdateStatus, ElgatoStatus, NativeState } from '../src/shared/native.ts';
