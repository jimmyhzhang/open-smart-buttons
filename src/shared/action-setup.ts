import type { ActionMeta, Controller, Hotkey } from './types.ts';

export type ActionMetaResolver = (type: string) => ActionMeta | undefined;

function settingsProblem(value: unknown, path = new Set<object>(), depth = 0, budget = { left: 10_000 }): string | null {
  if (--budget.left < 0 || depth > 40) return 'Action settings are too deeply nested or too large.';
  if (typeof value === 'number' && !Number.isFinite(value)) return 'Action settings must contain finite numbers.';
  if (value === null || value === undefined || ['string', 'number', 'boolean'].includes(typeof value)) return null;
  if (typeof value !== 'object') return 'Action settings must contain ordinary JSON values.';
  if (path.has(value)) return 'Action settings contain a circular reference.';
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return 'Action settings must contain ordinary JSON objects.';
  path.add(value);
  for (const child of Object.values(value)) {
    const problem = settingsProblem(child, path, depth + 1, budget);
    if (problem) return problem;
  }
  path.delete(value);
  return null;
}

/** Shared validation for the setup dialog and configured-assignment RPC, before mutation. */
export function validateActionSetup(meta: ActionMeta, settings: Record<string, unknown>, controller: Controller, resolveMeta?: ActionMetaResolver): string[] {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return ['Action settings must be an object'];
  const problem = settingsProblem(settings);
  if (problem) return [problem];
  return [...new Set(validate(meta, settings, controller, resolveMeta, new Set()).errors)];
}

function validate(meta: ActionMeta, settings: Record<string, unknown>, controller: Controller, resolveMeta: ActionMetaResolver | undefined, stepIds: Set<string>): { errors: string[]; executable: number } {
  const errors: string[] = [];
  for (const field of meta.fields) {
    if (field.controllers && !field.controllers.includes(controller)) continue;
    if (field.required && (typeof settings[field.key] !== 'string' || !String(settings[field.key]).trim())) errors.push(`${field.label} is required`);
  }
  if (meta.type.startsWith('agent.')) {
    if (settings.execution !== undefined && (typeof settings.execution !== 'string' || !['background', 'terminal'].includes(settings.execution))) errors.push('Choose Background or Terminal');
    if (settings.execution === 'background' && (typeof settings.prompt !== 'string' || !settings.prompt.trim())) errors.push('Prompt is required');
    if (settings.execution === 'background' && settings.mode !== 'new') errors.push('Background prompts start a new session');
    if (!['new', 'continue'].includes(String(settings.mode))) errors.push('Choose a valid session mode');
    if (settings.mode === 'continue' && String(settings.prompt || '').trim()) errors.push('Continue opens the last session without a new starting task');
  }
  if (meta.type === 'system.raycast' || meta.type === 'system.asyar') {
    const provider = meta.type.slice(7);
    const url = String(settings.url || '').trim();
    if (url) {
      try {
        const parsed = new URL(url);
        if (!(provider === 'raycast' ? ['raycast:', 'com.raycast:'] : ['asyar:']).includes(parsed.protocol) || !parsed.hostname) errors.push(`Paste a valid ${provider === 'raycast' ? 'Raycast' : 'Asyar'} command deep link`);
      } catch { errors.push('The command deep link is not a valid URL'); }
    }
  }
  if (meta.type === 'system.mac' && !['darkmode', 'lock', 'displaysleep', 'sleep', 'screensaver', 'missioncontrol', 'showdesktop', 'apps', 'spotlight', 'emoji', 'screenshot', 'forcequit', 'brightup', 'brightdown'].includes(String(settings.op))) errors.push('Choose a Mac control');
  if (meta.type === 'system.shortcut' && String(settings.name || '').trim().startsWith('-')) errors.push('A shortcut name cannot start with a dash');
  if (meta.type === 'system.open' && !String(settings.path || '').trim()) errors.push('App or path is required');
  if (meta.type === 'system.website' && !String(settings.url || '').trim()) errors.push('URL is required');
  if (meta.type === 'system.text' && !String(settings.text || '').trim()) errors.push('Text is required');
  if (meta.type === 'system.command' && controller === 'key' && !String(settings.command || '').trim()) errors.push('Command is required');
  if (meta.type === 'system.hotkey' && controller === 'key' && !(settings.hotkey as { key?: string } | null)?.key) errors.push('Record a shortcut first');
  if (controller === 'dial' && meta.type === 'system.command' &&
    !['left', 'right', 'press'].some(key => String(settings[key] || '').trim())) errors.push('Add a command for at least one dial control');
  if (controller === 'dial' && meta.type === 'system.hotkey' &&
    !['left', 'right', 'press'].some(key => (settings[key] as Hotkey | null)?.key)) errors.push('Record a shortcut for at least one dial control');
  if (meta.type === 'system.volume' && controller === 'key') {
    if (settings.mode !== undefined && !['mute', 'up', 'down'].includes(String(settings.mode))) errors.push('Choose a volume action');
    if (settings.mutedIconWhenSilent !== undefined && typeof settings.mutedIconWhenSilent !== 'boolean') errors.push('Show muted icon when silent must be on or off');
  }
  if (meta.type === 'sd.page.goto' && !settings.pageId) errors.push('Choose a page');
  if (meta.type === 'sd.profile' && !settings.profileId) errors.push('Choose a profile');
  if (meta.type === 'sd.delay') {
    if (typeof settings.ms !== 'number' || !Number.isFinite(settings.ms) || settings.ms < 0 || settings.ms > 60_000) errors.push('Delay must be a finite number between 0 and 60000 milliseconds');
    return { errors, executable: 0 };
  }
  if (meta.type !== 'sd.multi') return { errors, executable: meta.controllers.includes('key') && meta.type !== 'util.clock' && meta.category !== 'Hidden' ? 1 : 0 };
  const steps = settings.steps;
  if (!Array.isArray(steps)) return { errors: [...errors, 'Multi Action steps must be a list'], executable: 0 };
  let executable = 0;
  steps.forEach((step: unknown, i: number) => {
    const prefix = `Step ${i + 1}: `;
    if (!step || typeof step !== 'object' || Array.isArray(step)) return void errors.push(prefix + 'choose an action');
    const value = step as Record<string, unknown>;
    if (typeof value.id !== 'string' || !value.id.trim()) errors.push(prefix + 'action identifier is missing');
    else if (stepIds.has(value.id)) errors.push(prefix + 'each step needs a unique action identifier');
    else stepIds.add(value.id);
    const child = typeof value.type === 'string' ? resolveMeta?.(value.type) : undefined;
    if (!child) return void errors.push(prefix + (resolveMeta ? 'unknown action' : 'action catalog is required to validate this step'));
    if (child.type !== 'sd.delay' && (!child.controllers.includes('key') || child.type === 'util.clock' || child.category === 'Hidden')) return void errors.push(prefix + `${child.name} does not provide an executable key action`);
    if (!value.settings || typeof value.settings !== 'object' || Array.isArray(value.settings)) return void errors.push(prefix + 'action settings must be an object');
    if (child.type === 'sd.folder' && (typeof (value.settings as Record<string, unknown>).folderId !== 'string' || !String((value.settings as Record<string, unknown>).folderId).trim())) return void errors.push(prefix + 'choose an existing folder for this Multi Action step');
    const result = validate(child, { ...child.defaults, ...value.settings as Record<string, unknown> }, 'key', resolveMeta, stepIds);
    errors.push(...result.errors.map((error) => prefix + error));
    executable += result.executable;
  });
  if (!executable) errors.push('Add at least one executable action to the Multi Action; delays alone do not run an operation');
  return { errors, executable };
}

export function actionSummary(meta: ActionMeta, settings: Record<string, unknown>, controller: Controller = 'key'): string {
  const text = (key: string) => String(settings[key] || '').trim();
  if (meta.type === 'system.volume') {
    if (controller === 'dial') return 'Turn to change volume. Press to toggle mute.';
    const operation = settings.mode === 'down' ? 'Lower the volume' : settings.mode === 'up' ? 'Raise the volume' : 'Toggle mute';
    return settings.mutedIconWhenSilent === true ? `${operation}. Show the muted icon at zero volume or while muted.` : operation;
  }
  if (meta.type.startsWith('agent.')) return `${settings.execution === 'background' ? `Run ${meta.name} in the background` : `${settings.mode === 'continue' ? 'Continue' : 'Open'} ${meta.name} in Terminal`} · ${text('cwd') || 'Choose a project'}${text('prompt') ? ` · ${text('prompt').slice(0, 110)}` : ''}`;
  if (meta.type === 'system.script') return `Run ${text('path') || 'your executable script'}${text('arg1') ? ' with saved arguments' : ''}`;
  if (meta.type === 'system.shortcut') return `Run the “${text('name') || 'chosen'}” shortcut`;
  if (['system.raycast', 'system.asyar'].includes(meta.type)) return text('url') || 'Open the command link you copy from the launcher';
  if (meta.type === 'system.open') return `Open ${text('path') || 'an app, file or folder'}`;
  if (meta.type === 'system.website') return `Open ${text('url') || 'a website'}`;
  if (meta.type === 'system.command') return text('command') || 'Run your shell command';
  if (meta.type === 'system.text') return `${settings.paste ? 'Paste' : 'Type'} ${text('text') ? `“${text('text').slice(0, 90)}”` : 'your snippet'}`;
  if (meta.type === 'system.hotkey') {
    const h = settings.hotkey as Hotkey | null | undefined;
    return h?.key ? `Press ${hotkeyLabel(h)} in the app in front` : 'Press a keyboard shortcut you record';
  }
  // Single-choice actions (Mac controls, media keys…) read best as the chosen option.
  const choice = meta.fields.find((f) => f.type === 'select' && f.options && ['op', 'action'].includes(f.key));
  const picked = choice?.options?.find((o) => o.value === settings[choice.key]);
  if (picked) return picked.label;
  return meta.description;
}

function hotkeyLabel(h: Hotkey): string {
  const key = h.key.length === 1 ? h.key.toUpperCase() : h.key;
  return `${h.ctrl ? '⌃' : ''}${h.opt ? '⌥' : ''}${h.shift ? '⇧' : ''}${h.cmd ? '⌘' : ''}${key}`;
}
