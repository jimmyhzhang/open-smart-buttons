// One-click starter pages. Each layout lists ready-to-use presets in key order; the first
// eight fit a Neo/MK.2 row pair, extras fill larger decks. Dials get their own list.

export interface StarterLayout {
  id: string;
  name: string;
  description: string;
  icon: string;
  color: string;
  /** Preset (or plain action type) ids, in key order. */
  keys: string[];
  /** For devices with dials (Stream Deck +). */
  dials?: string[];
}

export const STARTER_LAYOUTS: StarterLayout[] = [
  {
    id: 'developer', name: 'Developer', description: 'Terminal, editor, GitHub and the Mac controls you reach for while coding.', icon: 'code-xml', color: '#60a5fa',
    keys: ['open-app-2', 'open-app-4', 'site-github', 'open-app-chrome', 'spotlight', 'mac-screenshot', 'mac-darkmode', 'mac-lock', 'copy', 'paste', 'undo', 'redo', 'mission-control', 'space-right', 'mac-awake'],
    dials: ['system.volume', 'sd.brightness'],
  },
  {
    id: 'meetings', name: 'Meetings', description: 'Mute, camera, share and raise hand for Zoom, plus your calendar.', icon: 'video', color: '#f87171',
    keys: ['zoom-mute', 'zoom-video', 'zoom-share', 'zoom-hand', 'open-app-zoom', 'open-app-calendar', 'media-volume-key', 'mac-awake', 'meet-mute', 'meet-video', 'teams-mute', 'teams-video', 'slack-huddle', 'site-gcal', 'mac-lock'],
    dials: ['system.volume'],
  },
  {
    id: 'media', name: 'Media', description: 'Playback, volume and your music apps.', icon: 'music', color: '#4ade80',
    keys: ['media-previous', 'media-playpause', 'media-next', 'media-volume-key', 'media-voldown', 'media-volup', 'open-app-music', 'open-app-spotify', 'site-youtube', 'media-mute'],
    dials: ['system.volume', 'sd.brightness'],
  },
  {
    id: 'everyday', name: 'Everyday Mac', description: 'Mission Control, desktop, screenshots, dark mode, snippets and lock.', icon: 'laptop', color: '#f472b6',
    keys: ['mac-missioncontrol', 'mac-desktop', 'spotlight', 'mac-screenshot', 'mac-darkmode', 'mac-awake', 'snip-date', 'mac-lock', 'open-app-3', 'open-app-mail', 'open-app-messages', 'mac-emoji', 'mac-apps', 'mac-displaysleep', 'open-app-settings'],
    dials: ['system.volume', 'sd.brightness'],
  },
];
