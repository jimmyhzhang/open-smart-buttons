// The application menu. Editor commands go to the editor renderer over `sdp:menu`; the renderer's own
// keydown handler keeps deck ⌘C/⌘V/⌘X, so the Edit menu uses standard roles only.

import { app, Menu, type MenuItemConstructorOptions } from 'electron';

import type { MenuCommand } from '../src/shared/native.ts';

/** Commands the editor renderer understands (ui/src/native.ts). */
export type RendererCommand = Exclude<MenuCommand, `settings.${string}`>;

export interface MenuHandlers {
  toRenderer(command: RendererCommand): void;
  openSettings(): void;
  openEditor(): void;
  rescan(): void;
  addSimulator(model: 'neo' | 'plus'): void;
  checkForUpdates(): void;
  copyDiagnostics(): void;
  showLogs(): void;
  editorReady(): boolean;
}

export function buildAppMenu(h: MenuHandlers): void {
  const editor = h.editorReady();
  const send = (command: RendererCommand) => () => { h.openEditor(); h.toRenderer(command); };
  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { label: 'Check for Updates…', click: () => h.checkForUpdates() },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'Command+,', click: () => h.openSettings() },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'File',
      submenu: [
        { label: 'New Profile', accelerator: 'Command+N', enabled: editor, click: send('profile.new') },
        { label: 'Import Profile…', accelerator: 'Shift+Command+I', enabled: editor, click: send('profile.import') },
        { label: 'Export Profile…', accelerator: 'Shift+Command+E', enabled: editor, click: send('profile.export') },
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Edit Mode', accelerator: 'Command+1', enabled: editor, click: send('mode.edit') },
        { label: 'Use Mode', accelerator: 'Command+2', enabled: editor, click: send('mode.use') },
        { type: 'separator' },
        // ⌘K stays with the renderer (it also works while typing in the action search).
        { label: 'Browse Actions', accelerator: 'Command+K', registerAccelerator: false, enabled: editor, click: send('actions.browse') },
        // ⌘I also stays with the renderer, which knows the selected key.
        { label: 'Configure Selected Key…', accelerator: 'Command+I', registerAccelerator: false, enabled: editor, click: send('slot.configure') },
        { label: 'Show Activity', accelerator: 'Shift+Command+L', enabled: editor, click: send('activity.toggle') },
        { type: 'separator' },
        ...(app.isPackaged ? [] : [{ role: 'reload' as const }, { role: 'toggleDevTools' as const }, { type: 'separator' as const }]),
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Device',
      submenu: [
        { label: 'Rescan for Decks', enabled: editor, click: () => h.rescan() },
        { label: 'Reconnect', enabled: editor, click: send('device.reconnect') },
        { type: 'separator' },
        {
          label: 'Simulators',
          enabled: editor,
          submenu: [
            { label: 'Add Stream Deck Neo', click: () => h.addSimulator('neo') },
            { label: 'Add Stream Deck +', click: () => h.addSimulator('plus') },
          ],
        },
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'Copy Diagnostics', click: () => h.copyDiagnostics() },
        { label: 'Show Logs', click: () => h.showLogs() },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
