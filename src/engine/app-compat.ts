import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { APP_NAME } from '../shared/brand.ts';

// Retained only to find existing installations and launch scripts.
export const LEGACY_APP_NAME = 'StreamDeckPlus';
export const LEGACY_APP_ID = 'ai.readingplus.streamdeckplus';
const LEGACY_DATA_FOLDER = '.streamdeckplus';
const LEGACY_ENV = {
  DATA: 'STREAMDECKPLUS_DATA', AI: 'STREAMDECK_AI',
  CLAUDE_MODEL: 'STREAMDECK_CLAUDE_MODEL', LOCAL_ONLY: 'STREAMDECK_LOCAL_ONLY',
} as const;

export function appSetting(key: keyof typeof LEGACY_ENV, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env[`OPEN_SMART_BUTTONS_${key}`] ?? env[LEGACY_ENV[key]];
}

function existingStore(current: string, legacy: string): string {
  return !existsSync(current) && existsSync(legacy) ? legacy : current;
}

export function appDataDir(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  return appSetting('DATA', env) || existingStore(join(home, '.open-smart-buttons'), join(home, LEGACY_DATA_FOLDER));
}

export function desktopUserDataDir(appData: string): string {
  return existingStore(join(appData, APP_NAME), join(appData, LEGACY_APP_NAME));
}

export function profileDirectoryArg(args: readonly string[]): string | undefined {
  const value = (name: string) => args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  const dir = value('osb-profile-dir') ?? value('sdp-profile-dir');
  if (dir !== undefined && !dir.trim()) throw new Error('The isolated profile directory must not be empty.');
  return dir;
}

export function isAppEnvironmentVariable(key: string): boolean {
  return /^(OPEN_SMART_BUTTONS_|OSB_|STREAMDECK_|STREAMDECKPLUS_)/.test(key);
}
