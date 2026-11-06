import type { InfoBarMode, TouchPointMode } from './types.ts';

export const TOUCH_POINT_MODES: { value: TouchPointMode; label: string; left: string; right: string }[] = [
  { value: 'pages', label: 'Switch pages', left: 'Previous page', right: 'Next page' },
  { value: 'media', label: 'Change track', left: 'Previous track', right: 'Next track' },
  { value: 'volume', label: 'Adjust volume', left: 'Volume down', right: 'Volume up' },
  { value: 'spaces', label: 'Switch desktops', left: 'Desktop on the left', right: 'Desktop on the right' },
  { value: 'none', label: 'Do nothing', left: 'Not used', right: 'Not used' },
];

export const INFO_BAR_MODES: { value: InfoBarMode; label: string }[] = [
  { value: 'clock', label: 'Time, date and page' },
  { value: 'page', label: 'Page name' },
  { value: 'off', label: 'Off' },
];

export function touchPointMode(v: unknown): TouchPointMode {
  return TOUCH_POINT_MODES.some((m) => m.value === v) ? (v as TouchPointMode) : 'pages';
}
export function infoBarMode(v: unknown): InfoBarMode {
  return INFO_BAR_MODES.some((m) => m.value === v) ? (v as InfoBarMode) : 'clock';
}
