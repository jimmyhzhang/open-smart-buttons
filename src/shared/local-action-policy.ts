import type { ActionInstance } from './types.ts';

const localTypes = new Set([
  'sd.brightness', 'sd.page.next', 'sd.page.prev', 'sd.page.goto', 'sd.page.indicator',
  'sd.folder', 'sd.back', 'sd.profile', 'sd.sleep', 'sd.delay',
  'util.counter', 'util.clock', 'system.volume',
]);
const macControls = new Set([
  'darkmode', 'lock', 'displaysleep', 'sleep', 'missioncontrol', 'showdesktop', 'spotlight',
  'emoji', 'screenshot', 'forcequit', 'brightup', 'brightdown',
]);

export const externalActionMessage = 'This action is unavailable under the local-only execution policy.';

export function canConfigureLocalAction(type: string): boolean {
  return localTypes.has(type) || ['sd.multi', 'util.toggle', 'system.multimedia', 'system.mac'].includes(type);
}

export function isLocalAction({ type, settings }: Pick<ActionInstance, 'type' | 'settings'>, depth = 0): boolean {
  if (!settings || depth > 40) return false;
  if (localTypes.has(type)) return true;
  if (type === 'system.mac') return typeof settings.op === 'string' && macControls.has(settings.op);
  if (type === 'system.multimedia') return ['mute', 'volup', 'voldown'].includes(String(settings.action));
  if (type === 'util.toggle') return !settings.onCommand && !settings.offCommand;
  if (type === 'sd.multi') return Array.isArray(settings.steps) && settings.steps.every(
    (step) => step && typeof step === 'object' && isLocalAction(step, depth + 1),
  );
  return false;
}
