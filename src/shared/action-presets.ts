import type { ActionMeta, Appearance, Controller, Hotkey } from './types.ts';
import { validateActionSetup, type ActionMetaResolver } from './action-setup.ts';

export type ActionCategory = 'AI & coding' | 'Apps' | 'Websites' | 'Mac' | 'Media' | 'Meetings' | 'Snippets' | 'Automation' | 'Deck';
export interface ActionChoice {
  id: string;
  type: string;
  name: string;
  description: string;
  category: ActionCategory;
  icon: string;
  color: string;
  settings: Record<string, unknown>;
  appearance?: Appearance;
  keywords?: string;
  featured?: boolean;
  /** Short note shown when the action only works in a specific app or needs a permission. */
  note?: string;
  /** Always open setup before saving (prefilled values are examples the user should adapt). */
  review?: boolean;
}

export const ACTION_CATEGORIES: ActionCategory[] = ['AI & coding', 'Apps', 'Websites', 'Mac', 'Media', 'Meetings', 'Snippets', 'Automation', 'Deck'];

const COLORS: Record<ActionCategory, string> = {
  'AI & coding': '#60a5fa', Apps: '#a78bfa', Websites: '#38bdf8', Mac: '#f472b6', Media: '#4ade80',
  Meetings: '#f87171', Snippets: '#fbbf24', Automation: '#34d399', Deck: '#94a3b8',
};

interface PresetInput {
  id: string;
  type: string;
  name: string;
  category: ActionCategory;
  description: string;
  settings: Record<string, unknown>;
  icon: string;
  color?: string;
  featured?: boolean;
  keywords?: string;
  note?: string;
  /** Button label when it differs from the preset name (kept short for the key). */
  label?: string;
  review?: boolean;
}
const p = (x: PresetInput): ActionChoice => ({
  id: x.id, type: x.type, name: x.name, category: x.category, description: x.description, settings: x.settings,
  icon: x.icon, color: x.color ?? COLORS[x.category], featured: x.featured, keywords: x.keywords, note: x.note, review: x.review,
  appearance: { title: x.label ?? x.name },
});
const hotkey = (id: string, name: string, category: ActionCategory, description: string, h: Hotkey, icon: string, extra: Partial<PresetInput> = {}) =>
  p({ id, type: 'system.hotkey', name, category, description, settings: { hotkey: h }, icon, ...extra });
const app = (id: string, name: string, icon: string, keywords = '', label?: string) =>
  p({ id, type: 'system.open', name: `Open ${name}`, category: 'Apps', description: `Open ${name}, or bring it to the front.`, settings: { path: name }, icon, keywords: `${keywords} launch app`, label: label ?? name });
const site = (id: string, name: string, url: string, icon: string, keywords = '') =>
  p({ id, type: 'system.website', name, category: 'Websites', description: `Open ${url.replace(/^https:\/\//, '')} in your browser.`, settings: { url }, icon, keywords: `${keywords} website link url browser` });
const mac = (id: string, op: string, name: string, description: string, icon: string, keywords = '', note?: string) =>
  p({ id, type: 'system.mac', name, category: 'Mac', description, settings: { op }, icon, keywords, note });
const snippet = (id: string, name: string, text: string, description: string, icon: string, keywords = '', label?: string) =>
  p({ id, type: 'system.text', name, category: 'Snippets', description, settings: { text, paste: true, enter: false }, icon, keywords: `${keywords} text type paste snippet`, label });
const meeting = (id: string, name: string, appName: string, h: Hotkey, icon: string, label: string) =>
  hotkey(id, name, 'Meetings', `Sends ${appName}'s shortcut. ${appName} must be the active window.`, h, icon, { keywords: `${appName} call meeting`, note: `Works while ${appName} is in front`, label });

/** Original, editable starting points. No preset runs until its saved button is pressed. */
export const ACTION_PRESETS: ActionChoice[] = [
  // ---- AI & coding
  p({ id: 'codex-review', type: 'agent.codex', name: 'Review with Codex', category: 'AI & coding', description: 'A fresh set of eyes on your current changes.', settings: { mode: 'new', prompt: 'Review the current changes for concrete bugs and regressions. Explain your findings before making edits.' }, icon: 'scan-eye', featured: true, keywords: 'openai agent code review', label: 'Review' }),
  p({ id: 'claude-build', type: 'agent.claude', name: 'Build with Claude', category: 'AI & coding', description: 'Open a project with a task ready to go.', settings: { mode: 'new', prompt: '' }, icon: 'sparkles', color: '#f5ab78', featured: true, keywords: 'anthropic agent', label: 'Claude' }),
  p({ id: 'codex-tests', type: 'agent.codex', name: 'Fix failing tests', category: 'AI & coding', description: 'Investigate the failure, then make a focused fix.', settings: { mode: 'new', prompt: 'Inspect this project and its test instructions. Run the relevant tests, diagnose failures, and fix the cause with focused validation.' }, icon: 'flask-conical', keywords: 'codex agent test', label: 'Fix tests' }),
  p({ id: 'claude-explain', type: 'agent.claude', name: 'Explain this project', category: 'AI & coding', description: 'Map the important files and how they work together.', settings: { mode: 'new', prompt: 'Explain this project architecture and its main flows. Cite the relevant files and do not edit anything.' }, icon: 'book-open', color: '#f5ab78', keywords: 'claude agent onboarding', label: 'Explain' }),
  p({ id: 'codex-continue', type: 'agent.codex', name: 'Continue Codex', category: 'AI & coding', description: 'Return to the latest session for your project.', settings: { mode: 'continue', prompt: '' }, icon: 'history', keywords: 'resume agent' }),
  p({ id: 'claude-continue', type: 'agent.claude', name: 'Continue Claude', category: 'AI & coding', description: 'Pick up the last conversation in this folder.', settings: { mode: 'continue', prompt: '' }, icon: 'history', color: '#f5ab78', keywords: 'resume agent' }),
  p({ id: 'open-in-vscode', review: true, type: 'system.command', name: 'Open project in VS Code', category: 'AI & coding', description: 'Open a project folder in Visual Studio Code.', settings: { command: 'open -a "Visual Studio Code" ~/repos/my-project', showOutput: false }, icon: 'code-xml', keywords: 'editor ide vscode code', label: 'VS Code' }),
  app('open-app-2', 'Terminal', 'square-terminal', 'shell console'),
  site('site-github', 'GitHub', 'https://github.com', 'git-branch', 'code repo pull requests'),
  site('site-chatgpt', 'ChatGPT', 'https://chatgpt.com', 'message-square', 'openai ai chat'),
  site('site-claude', 'Claude', 'https://claude.ai', 'sparkles', 'anthropic ai chat'),

  // ---- Apps
  app('open-app-0', 'Safari', 'compass', 'browser web'),
  app('open-app-chrome', 'Google Chrome', 'aperture', 'browser web', 'Chrome'),
  app('open-app-3', 'Finder', 'folder', 'files'),
  app('open-app-1', 'Notes', 'notebook-pen', 'writing'),
  app('open-app-4', 'Visual Studio Code', 'code-xml', 'editor ide vscode', 'VS Code'),
  app('open-app-mail', 'Mail', 'mail', 'email inbox'),
  app('open-app-calendar', 'Calendar', 'calendar', 'schedule events'),
  app('open-app-messages', 'Messages', 'message-circle', 'imessage chat sms'),
  app('open-app-music', 'Music', 'music', 'songs apple music'),
  app('open-app-spotify', 'Spotify', 'music-2', 'songs streaming'),
  app('open-app-slack', 'Slack', 'hash', 'chat team'),
  app('open-app-zoom', 'zoom.us', 'video', 'meeting call', 'Zoom'),
  app('open-app-reminders', 'Reminders', 'list-checks', 'todo tasks'),
  app('open-app-settings', 'System Settings', 'settings', 'preferences'),
  app('open-app-activity', 'Activity Monitor', 'activity', 'cpu processes'),
  p({ id: 'open-project', type: 'system.open', name: 'Open a folder', category: 'Apps', description: 'Keep a project or folder one press away.', settings: { path: '' }, icon: 'folder-open', keywords: 'directory finder project', label: 'Folder' }),

  // ---- Websites
  site('site-gmail', 'Gmail', 'https://mail.google.com', 'mail', 'email google'),
  site('site-gcal', 'Google Calendar', 'https://calendar.google.com', 'calendar-days', 'schedule google'),
  site('site-youtube', 'YouTube', 'https://www.youtube.com', 'square-play', 'video'),
  site('site-drive', 'Google Drive', 'https://drive.google.com', 'hard-drive', 'files docs google'),
  p({ id: 'site-custom', type: 'system.website', name: 'Any website', category: 'Websites', description: 'Open a page you visit often.', settings: { url: '' }, icon: 'globe', keywords: 'link url bookmark', label: 'Website' }),

  // ---- Mac
  mac('mac-darkmode', 'darkmode', 'Toggle dark mode', 'Switch between light and dark appearance.', 'sun-moon', 'appearance theme light'),
  mac('mac-lock', 'lock', 'Lock screen', 'Lock your Mac right away.', 'lock', 'security away'),
  mac('mac-displaysleep', 'displaysleep', 'Turn display off', 'Put the display to sleep; your apps keep running.', 'monitor-off', 'screen off blank'),
  mac('mac-missioncontrol', 'missioncontrol', 'Mission Control', 'See all your open windows and spaces.', 'panels-top-left', 'windows spaces expose'),
  mac('mac-desktop', 'showdesktop', 'Show desktop', 'Move windows aside to see the desktop.', 'monitor', 'windows hide'),
  mac('mac-apps', 'apps', 'Show all apps', 'Open Launchpad / the Apps view.', 'layout-grid', 'launchpad applications'),
  hotkey('spotlight', 'Spotlight', 'Mac', 'Find an app, file or answer.', { key: 'Space', cmd: true }, 'search', { keywords: 'find launcher' }),
  mac('mac-emoji', 'emoji', 'Emoji & symbols', 'Open the emoji picker where you are typing.', 'smile', 'character viewer'),
  mac('mac-screenshot', 'screenshot', 'Screenshot tools', 'Capture or record the screen.', 'camera', 'screen capture record'),
  hotkey('screenshot', 'Capture a region', 'Mac', 'Drag to capture part of the screen.', { key: '4', cmd: true, shift: true }, 'crop', { keywords: 'screenshot capture', label: 'Region' }),
  mac('mac-forcequit', 'forcequit', 'Force Quit', 'Open the Force Quit Applications window.', 'octagon-x', 'kill frozen app'),
  mac('mac-brightup', 'brightup', 'Display brighter', 'Raise the display brightness.', 'sun', 'screen brightness up', 'Needs Accessibility'),
  mac('mac-brightdown', 'brightdown', 'Display dimmer', 'Lower the display brightness.', 'sun-dim', 'screen brightness down', 'Needs Accessibility'),
  mac('mac-screensaver', 'screensaver', 'Start screen saver', 'Start your screen saver now.', 'monitor-play', 'idle'),
  mac('mac-sleep', 'sleep', 'Sleep', 'Put the Mac to sleep.', 'moon', 'power rest'),
  p({ id: 'mac-awake', type: 'util.awake', name: 'Keep awake', category: 'Mac', description: 'Stop your Mac and display from sleeping until you press again.', settings: {}, icon: 'coffee', keywords: 'caffeinate amphetamine no sleep presentation', label: 'Awake' }),
  hotkey('copy', 'Copy', 'Mac', 'Copy the current selection.', { key: 'c', cmd: true }, 'copy', { keywords: 'clipboard edit' }),
  hotkey('paste', 'Paste', 'Mac', 'Paste into the focused app.', { key: 'v', cmd: true }, 'clipboard-paste', { keywords: 'clipboard edit' }),
  hotkey('undo', 'Undo', 'Mac', 'Undo in the focused app.', { key: 'z', cmd: true }, 'undo-2', { keywords: 'edit' }),
  hotkey('redo', 'Redo', 'Mac', 'Redo in the focused app.', { key: 'z', cmd: true, shift: true }, 'redo-2', { keywords: 'edit' }),
  hotkey('mission-control', 'Switch desktop left', 'Mac', 'Move to the space on the left.', { key: 'Left', ctrl: true }, 'arrow-left-to-line', { keywords: 'spaces desktop', label: 'Space ←' }),
  hotkey('space-right', 'Switch desktop right', 'Mac', 'Move to the space on the right.', { key: 'Right', ctrl: true }, 'arrow-right-to-line', { keywords: 'spaces desktop', label: 'Space →' }),
  hotkey('desktop', 'Close window', 'Mac', 'Close the front window.', { key: 'w', cmd: true }, 'x', { keywords: 'window' }),
  hotkey('quit-app', 'Quit app', 'Mac', 'Quit the app in front.', { key: 'q', cmd: true }, 'power', { keywords: 'close application' }),
  hotkey('hide-app', 'Hide app', 'Mac', 'Hide the app in front.', { key: 'h', cmd: true }, 'eye-off', { keywords: 'window' }),
  hotkey('app-switcher', 'New tab', 'Mac', 'Open a new tab in the front app.', { key: 't', cmd: true }, 'plus', { keywords: 'browser tab' }),

  // ---- Media
  ...(['playpause', 'previous', 'next', 'mute', 'volup'] as const).map((action, i) => p({
    id: `media-${action}`, type: 'system.multimedia', name: ['Play / Pause', 'Previous track', 'Next track', 'Mute', 'Volume up'][i]!,
    category: 'Media', description: ['Play or pause whatever is playing.', 'Go back a track.', 'Skip to the next track.', 'Mute or unmute your Mac.', 'Turn the volume up a step.'][i]!,
    settings: { action }, icon: ['circle-play', 'skip-back', 'skip-forward', 'volume-x', 'volume-2'][i]!,
    keywords: 'audio music sound spotify', label: ['Play', 'Prev', 'Next', 'Mute', 'Vol +'][i]!,
  })),
  p({ id: 'media-voldown', type: 'system.volume', name: 'Volume down', category: 'Media',
    description: 'Lower the volume. Show a muted icon when sound is off.', settings: { mode: 'down', mutedIconWhenSilent: true },
    icon: 'volume-1', keywords: 'audio music sound spotify zero silent', label: 'Vol −' }),
  p({ id: 'media-volume-key', type: 'system.volume', name: 'Volume with level', category: 'Media', description: 'Shows the current volume on the button; press to mute.', settings: { mode: 'mute' }, icon: 'volume-2', keywords: 'audio sound level', label: 'Volume' }),

  // ---- Meetings
  meeting('zoom-mute', 'Zoom: mute', 'Zoom', { key: 'a', cmd: true, shift: true }, 'mic-off', 'Mute'),
  meeting('zoom-video', 'Zoom: camera', 'Zoom', { key: 'v', cmd: true, shift: true }, 'video-off', 'Camera'),
  meeting('zoom-share', 'Zoom: share screen', 'Zoom', { key: 's', cmd: true, shift: true }, 'screen-share', 'Share'),
  meeting('zoom-hand', 'Zoom: raise hand', 'Zoom', { key: 'y', opt: true }, 'hand', 'Hand'),
  meeting('meet-mute', 'Google Meet: mute', 'Google Meet', { key: 'd', cmd: true }, 'mic-off', 'Mute'),
  meeting('meet-video', 'Google Meet: camera', 'Google Meet', { key: 'e', cmd: true }, 'video-off', 'Camera'),
  meeting('teams-mute', 'Teams: mute', 'Microsoft Teams', { key: 'm', cmd: true, shift: true }, 'mic-off', 'Mute'),
  meeting('teams-video', 'Teams: camera', 'Microsoft Teams', { key: 'o', cmd: true, shift: true }, 'video-off', 'Camera'),
  meeting('slack-huddle', 'Slack huddle: mute', 'Slack', { key: 'Space', cmd: true, shift: true }, 'headphones', 'Huddle'),

  // ---- Snippets
  snippet('snip-date', "Today's date", '{date}', 'Type today’s date, e.g. “November 3, 2026”.', 'calendar', 'day stamp', 'Date'),
  snippet('snip-isodate', 'ISO date', '{isodate}', 'Type a sortable date, e.g. 2026-11-03.', 'calendar-days', 'yyyy-mm-dd stamp', 'ISO date'),
  snippet('snip-time', 'Current time', '{time}', 'Type the time right now.', 'clock', 'now stamp', 'Time'),
  snippet('snip-email', 'Email address', '', 'Type your email address anywhere.', 'at-sign', 'mail signature', 'Email'),
  snippet('snip-thanks', 'Thank you', 'Thank you!', 'A quick thank-you.', 'heart', 'reply', 'Thanks'),
  snippet('snip-lgtm', 'Looks good to me', 'LGTM 👍', 'Approve a review in one press.', 'thumbs-up', 'review approve code', 'LGTM'),
  snippet('snip-custom', 'Text snippet', '', 'Type any text you use often.', 'type', 'template signature', 'Snippet'),

  // ---- Automation
  p({ id: 'auto-shortcut', type: 'system.shortcut', name: 'Run a Shortcut', category: 'Automation', description: 'Run any shortcut from the Shortcuts app.', settings: { name: '' }, icon: 'workflow', keywords: 'apple shortcuts siri automation', label: 'Shortcut' }),
  p({ id: 'auto-command', type: 'system.command', name: 'Run a shell command', category: 'Automation', description: 'Run a command in the background and show the result.', settings: { command: '', showOutput: true }, icon: 'square-terminal', keywords: 'bash zsh script cli', label: 'Command' }),
  p({ id: 'auto-git-pull', review: true, type: 'system.command', name: 'git pull a project', category: 'Automation', description: 'Update a repository and show the result on the button.', settings: { command: 'git -C ~/repos/my-project pull --ff-only', showOutput: true }, icon: 'git-pull-request-arrow', keywords: 'git update repo sync', label: 'git pull' }),
  p({ id: 'auto-say', review: true, type: 'system.command', name: 'Speak a phrase', category: 'Automation', description: 'Have your Mac say something out loud.', settings: { command: 'say "Break time"', showOutput: false }, icon: 'megaphone', keywords: 'voice announce timer', label: 'Say' }),
];

export function actionCategory(meta: ActionMeta): ActionCategory {
  if (meta.type.startsWith('agent.')) return 'AI & coding';
  if (meta.type === 'system.open') return 'Apps';
  if (meta.type === 'system.website') return 'Websites';
  if (['system.multimedia', 'system.volume'].includes(meta.type)) return 'Media';
  if (meta.type === 'system.text') return 'Snippets';
  if (['system.command', 'system.script', 'system.shortcut', 'system.raycast', 'system.asyar'].includes(meta.type)) return 'Automation';
  if (meta.type.startsWith('system.') || meta.type === 'util.awake') return 'Mac';
  return 'Deck';
}

export function actionChoices(catalog: ActionMeta[]): ActionChoice[] {
  const types = new Set(catalog.map((m) => m.type));
  return [
    ...ACTION_PRESETS.filter((x) => types.has(x.type)),
    ...catalog.filter((m) => m.category !== 'Hidden').map((m) => ({ id: m.type, type: m.type, name: m.name, description: m.description, category: actionCategory(m), icon: m.icon, color: m.color, settings: {} })),
  ];
}

export function matchesAction(choice: ActionChoice, query: string): boolean {
  const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const haystack = `${choice.name} ${choice.description} ${choice.type} ${choice.category} ${choice.keywords || ''}`.toLowerCase();
  return words.every((word) => haystack.includes(word));
}

/** Search ranking: name prefix > name word > keyword > description. */
export function actionScore(choice: ActionChoice, query: string): number {
  const q = query.toLowerCase().trim();
  if (!q) return 0;
  const name = choice.name.toLowerCase();
  if (name.startsWith(q)) return 100;
  if (name.split(/[^a-z0-9]+/).some((w) => w.startsWith(q))) return 80;
  if ((choice.keywords || '').toLowerCase().split(/\s+/).some((w) => w.startsWith(q))) return 60;
  return 20;
}

/**
 * True when a choice can be placed with one click: it is fully specified, valid as-is,
 * and is not one of the examples the user is expected to adapt.
 */
export function isOneStepChoice(choice: ActionChoice, meta: ActionMeta, controller: Controller, resolve?: ActionMetaResolver): boolean {
  if (choice.review || !meta.controllers.includes(controller)) return false;
  // Anything that runs code or an agent always gets a review step.
  if (meta.type.startsWith('agent.') || meta.type === 'system.command' || meta.type === 'system.script') return false;
  // A plain catalog action with settings would land with placeholder defaults; ask first.
  if (choice.id === choice.type && meta.fields.some((f) => f.type !== 'folder' && (!f.controllers || f.controllers.includes(controller)))) return false;
  // On a dial, hotkeys and text need per-direction values that presets don't carry.
  if (controller === 'dial' && ['system.hotkey', 'system.text'].includes(meta.type)) {
    const s = choice.settings;
    if (!s.left && !s.right && !s.press) return false;
  }
  return validateActionSetup(meta, { ...structuredClone(meta.defaults), ...structuredClone(choice.settings) }, controller, resolve).length === 0;
}

/** The appearance a new button gets from a choice (same defaults as the setup dialog). */
export function choiceAppearance(choice: ActionChoice, meta?: ActionMeta): Appearance {
  const a: Appearance = { ...structuredClone(choice.appearance ?? {}), title: choice.appearance?.title || choice.name, bg: choice.appearance?.bg || '#0f172a' };
  // The action's own icon stays automatic so live states (muted, toggled) keep showing.
  if (choice.icon !== meta?.icon) a.icon = { kind: 'lucide', name: choice.icon };
  return a;
}
