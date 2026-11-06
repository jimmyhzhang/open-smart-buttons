import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MacPlatform, PermissionError, type CommandRunner } from '../src/engine/platform.ts';

test('macOS permissions: passive checks refresh trust without triggering System Events consent', async () => {
  let trusted = false;
  let automationChecks = 0;
  const runner: CommandRunner = async (_cmd, args) => {
    if (args.join(' ').includes('System Events')) {
      automationChecks++;
      return { code: 0, stdout: 'Finder', stderr: '' };
    }
    return { code: 0, stdout: String(trusted), stderr: '' };
  };
  const mac = new MacPlatform(runner);
  assert.deepEqual((await mac.checkPermissions()).map((p) => p.ok), [false, null]);
  await assert.rejects(mac.hotkey({ key: 'c', cmd: true }), PermissionError);
  assert.equal(automationChecks, 0, 'denied actions never send keystrokes');
  trusted = true;
  assert.deepEqual((await mac.checkPermissions()).map((p) => p.ok), [true, null], 'Check again bypasses the old denial cache');
  assert.equal(automationChecks, 0, 'passive refresh does not request consent');
  assert.deepEqual((await mac.checkPermissions(true, true)).map((p) => p.ok), [true, true]);
  assert.equal(automationChecks, 1);
  assert.deepEqual((await mac.checkPermissions()).map((p) => p.ok), [true, true], 'passive refresh retains the verified Automation result');
  assert.equal(automationChecks, 1);
});

test('macOS permission checker failures are unknown and prevent input execution', async () => {
  let calls = 0;
  const mac = new MacPlatform(async () => {
    calls++;
    return { code: 1, stdout: '', stderr: 'osascript unavailable' };
  });
  const checks = await mac.checkPermissions();
  assert.equal(checks[0]!.ok, null);
  assert.match(checks[0]!.detail, /osascript unavailable/);
  await assert.rejects(mac.hotkey({ key: 'c', cmd: true }), /Couldn't check Accessibility/);
  assert.equal(calls, 2, 'no attempt to post input after checker failure');
});

test('macOS volume media actions bypass Accessibility, clamp volume, and toggle actual mute state', async () => {
  const scripts: string[] = [];
  const mac = new MacPlatform(async (_cmd, args) => {
    const script = args.at(-1)!;
    scripts.push(script);
    return { code: 0, stdout: script.includes('get volume settings') ? '98,true' : 'false', stderr: '' };
  });
  await mac.media('volup');
  await mac.media('voldown');
  await mac.media('mute');
  assert.ok(scripts.includes('set volume output volume 100'));
  assert.ok(scripts.includes('set volume output volume 92'));
  assert.ok(scripts.includes('set volume output muted false'));
  assert.ok(scripts.every((s) => !s.includes('AXIsProcessTrusted') && !s.includes('System Events')));
  await assert.rejects(mac.media('playpause'), PermissionError, 'track controls still require Accessibility');
});

test('macOS failed paste restores clipboard text and the following queued paste still works', async () => {
  let clipboard = 'original clipboard';
  let pasteAttempts = 0;
  const pasted: string[] = [];
  const runner: CommandRunner = async (cmd, args, _timeout, input) => {
    if (cmd === 'pbpaste') return { code: 0, stdout: clipboard, stderr: '' };
    if (cmd === 'pbcopy') { clipboard = input!; return { code: 0, stdout: '', stderr: '' }; }
    const script = args.at(-1)!;
    if (script.includes('AXIsProcessTrusted')) return { code: 0, stdout: 'true', stderr: '' };
    if (script.includes('key code 9')) {
      if (++pasteAttempts === 1) return { code: 1, stdout: '', stderr: 'Not authorized to send Apple events (-1743)' };
      pasted.push(clipboard);
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  const mac = new MacPlatform(runner);
  const failed = assert.rejects(mac.typeText('blocked', { paste: true }), (e: unknown) => e instanceof PermissionError && e.permission === 'automation');
  const second = mac.typeText('second', { paste: true, enter: true });
  const third = mac.typeText('third', { paste: true });
  await Promise.all([failed, second, third]);
  assert.deepEqual(pasted, ['second', 'third'], 'queued operations paste their own text');
  assert.equal(clipboard, 'original clipboard');
});

test('macOS rapid volume presses are serialized and a failed change does not block the next press', async () => {
  let volume = 50;
  let muted = false;
  let fail = true;
  const mac = new MacPlatform(async (_cmd, args) => {
    const script = args.at(-1)!;
    if (script.includes('get volume settings')) {
      const snapshot = `${volume},${muted}`;
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (fail) { fail = false; return { code: 1, stdout: '', stderr: 'audio temporarily unavailable' }; }
      return { code: 0, stdout: snapshot, stderr: '' };
    }
    if (script.startsWith('set volume output volume ')) volume = Number(script.split(' ').at(-1));
    if (script.startsWith('set volume output muted ')) muted = script.endsWith('true');
    return { code: 0, stdout: '', stderr: '' };
  });
  const failure = assert.rejects(mac.media('volup'), /audio temporarily unavailable/);
  await Promise.all([failure, mac.media('volup'), mac.media('volup'), mac.media('mute'), mac.media('mute')]);
  assert.equal(volume, 62, 'each rapid press applies its increment');
  assert.equal(muted, false, 'two rapid mute presses toggle twice');
});

test('macOS paste order is preserved while the first Accessibility check is still pending', async () => {
  let finishTrust!: () => void;
  const trustGate = new Promise<void>((resolve) => { finishTrust = resolve; });
  let trustCalls = 0;
  let clipboard = 'original';
  const pasted: string[] = [];
  const mac = new MacPlatform(async (cmd, args, _timeout, input) => {
    if (cmd === 'pbpaste') return { code: 0, stdout: clipboard, stderr: '' };
    if (cmd === 'pbcopy') clipboard = input!;
    if (args.at(-1)?.includes('AXIsProcessTrusted') && ++trustCalls === 1) await trustGate;
    if (args.at(-1)?.includes('key code 9')) pasted.push(clipboard);
    return { code: 0, stdout: 'true', stderr: '' };
  });
  const first = mac.typeText('first', { paste: true });
  const second = mac.typeText('second', { paste: true });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(trustCalls, 1, 'the second paste cannot overtake the first permission check');
  finishTrust();
  await Promise.all([first, second]);
  assert.deepEqual(pasted, ['first', 'second']);
  assert.equal(clipboard, 'original');
});

test('macOS paste preserves a clipboard edit made by the user while the target consumes the paste', async () => {
  let clipboard = 'original';
  const mac = new MacPlatform(async (cmd, args, _timeout, input) => {
    if (cmd === 'pbpaste') return { code: 0, stdout: clipboard, stderr: '' };
    if (cmd === 'pbcopy') clipboard = input!;
    if (args.at(-1)?.includes('key code 9')) clipboard = 'user copied something else';
    return { code: 0, stdout: 'true', stderr: '' };
  });
  await mac.typeText('snippet', { paste: true });
  assert.equal(clipboard, 'user copied something else');
});

test('macOS paste stops if clipboard capture or write fails', async () => {
  for (const failingCommand of ['pbpaste', 'pbcopy']) {
    let sent = false;
    const mac = new MacPlatform(async (cmd, args) => {
      if (cmd === failingCommand) return { code: 1, stdout: '', stderr: 'clipboard unavailable' };
      if (args.at(-1)?.includes('System Events')) sent = true;
      return { code: 0, stdout: 'true', stderr: '' };
    });
    await assert.rejects(mac.typeText('snippet', { paste: true }), /clipboard unavailable/);
    assert.equal(sent, false, 'never paste a stale clipboard after an error');
  }
});
