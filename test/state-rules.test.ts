import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeviceManager } from '../src/device/manager.ts';
import { Engine } from '../src/engine/engine.ts';
import { Store } from '../src/engine/store.ts';
import { DryRunPlatform, MacPlatform, type CommandRunner } from '../src/engine/platform.ts';
import { StateHub, parseStateKey } from '../src/engine/state-hub.ts';
import { createRpc } from '../src/server/rpc.ts';
import { activeRule, describeRule, ruleMatches, stateKey, validateStateRules, type StateRule } from '../src/shared/state-rules.ts';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function boot() {
  const store = new Store(mkdtempSync(join(tmpdir(), 'sdp-')));
  store.config.settings.executeActions = false;
  const manager = new DeviceManager();
  const engine = new Engine(store, manager);
  const rpc = createRpc(engine);
  const dev = await manager.addSimulator('plus', { pageLatencyMs: 0 });
  for (let i = 0; i < 40 && !manager.simFor(dev)!.fb.keys.every(Boolean); i++) await wait(50);
  await wait(100);
  const session = engine.sessions.get(dev.id)!;
  const base = { profileId: session.profileId, pageId: session.pageId, kind: 'key' };
  const iconName = (i: number) => { const icon = session.keyVisual(i)?.icon; return icon?.kind === 'lucide' ? icon.name : undefined; };
  return { store, manager, engine, rpc, session, base, iconName, sim: engine.platform as DryRunPlatform };
}

const muted: StateRule = { source: 'muted', op: 'is', value: true, icon: { kind: 'lucide', name: 'volume-x' } };

test('rules match by source kind; the first match wins; unknown state never matches', () => {
  assert.equal(ruleMatches({ source: 'volume', op: '<=', value: 0, bg: '#000000' }, 0), true);
  assert.equal(ruleMatches({ source: 'volume', op: '<=', value: 0, bg: '#000000' }, 6), false);
  assert.equal(ruleMatches({ source: 'volume', op: '<=', value: 0, bg: '#000000' }, undefined), false);
  assert.equal(ruleMatches({ source: 'frontApp', op: 'contains', value: 'code', title: 'IDE' }, 'Visual Studio Code'), true);
  assert.equal(ruleMatches({ source: 'frontApp', op: 'isNot', value: 'Finder', title: 'x' }, 'finder'), false);
  assert.equal(ruleMatches({ source: 'darkMode', op: 'is', value: false, title: 'Day' }, false), true);
  const rules: StateRule[] = [{ ...muted, title: 'first' }, { source: 'volume', op: '<=', value: 0, title: 'second' }];
  assert.equal(activeRule(rules, new Map<string, number | boolean>([['muted', true], ['volume', 0]]))?.title, 'first');
  assert.equal(activeRule(rules, new Map<string, number | boolean>([['muted', false], ['volume', 0]]))?.title, 'second');
  assert.equal(stateKey({ source: 'appRunning', arg: ' Zoom ' }), 'appRunning:Zoom');
  assert.deepEqual(parseStateKey('appRunning:zoom.us'), { source: 'appRunning', arg: 'zoom.us' });
  assert.throws(() => parseStateKey('volume:x'));
  assert.throws(() => parseStateKey('rm -rf'));
  assert.equal(describeRule({ source: 'volume', op: '<=', value: 0, title: 'x' }), 'Output volume ≤ 0%');
  assert.equal(describeRule({ source: 'appRunning', arg: 'Zoom', op: 'is', value: true, title: 'x' }), 'Zoom running');
});

test('validation explains each problem and accepts well-formed rules', () => {
  assert.deepEqual(validateStateRules([muted, { source: 'appRunning', arg: 'Zoom', op: 'is', value: true, bg: '#7f1d1d', title: 'On air' }]), []);
  const errors = validateStateRules([
    { source: 'cpu', op: 'is', value: 1, title: 'x' },
    { source: 'volume', op: 'contains', value: '0', title: 'x' },
    { source: 'appRunning', op: 'is', value: true, title: 'x' },
    { source: 'muted', op: 'is', value: true },
    { source: 'muted', op: 'is', value: true, bg: 'red', run: 'x' },
  ]);
  assert.match(errors.join('\n'), /Rule 1 needs a known source/);
  assert.match(errors.join('\n'), /Rule 2: “contains” doesn't apply/);
  assert.match(errors.join('\n'), /Rule 2: the value must be a number/);
  assert.match(errors.join('\n'), /Rule 3: enter the app name/);
  assert.match(errors.join('\n'), /Rule 4 must change the icon, background or title/);
  assert.match(errors.join('\n'), /Rule 5 has an unknown field “run”/);
  assert.match(errors.join('\n'), /Rule 5: the background must be a #RRGGBB color/);
  assert.deepEqual(validateStateRules(new Array(9).fill(muted)), ['Use at most 8 state rules']);
});

test('a key follows the computer state; volume and mute share one reading', async () => {
  let reads = 0;
  const platform = new DryRunPlatform('macos', () => {});
  const getVolume = platform.getVolume.bind(platform);
  platform.getVolume = () => { reads++; return getVolume(); };
  const hub = new StateHub(() => platform);
  assert.deepEqual([...await hub.refresh(['volume', 'muted', 'darkMode'])].sort(), ['darkMode', 'muted', 'volume']);
  assert.equal(reads, 1);
  assert.equal((await hub.refresh(['volume', 'muted'])).size, 0, 'not due again within its interval');
  assert.equal(reads, 1);
  await hub.refresh(['battery', 'appRunning:Zoom'], true);
  assert.equal(hub.values.get('battery'), 80);
  assert.equal(hub.values.get('appRunning:Zoom'), false);
});

test('rules change the rendered look, reach dials, and a press updates other keys at once', async (t) => {
  const { rpc, engine, session, base, iconName, sim, manager } = await boot();
  t.after(() => manager.stop());
  await rpc['slots.assign']!({ ...base, index: 0, type: 'system.open', configured: true, settings: { path: '/Applications' }, appearance: { icon: { kind: 'lucide', name: 'sun' }, bg: '#000000' } });
  await rpc['slots.update']!({ ...base, index: 0, stateRules: [{ source: 'darkMode', op: 'is', value: true, icon: { kind: 'lucide', name: 'moon' }, bg: '#0f172a', title: 'Night' }] });
  await engine.refreshStates(true);
  assert.equal(iconName(0), 'sun');
  sim.simulated.darkMode = true;
  await engine.refreshStates(true);
  assert.equal(iconName(0), 'moon');
  assert.equal(session.keyVisual(0)?.bg, '#0f172a');
  assert.equal(session.keyVisual(0)?.title, 'Night');
  assert.equal(session.keyVisual(0)?.showTitle, true);
  sim.simulated.darkMode = false;
  await engine.refreshStates(true);
  assert.equal(iconName(0), 'sun', 'the normal look returns');

  // The Key 5 / Key 6 case: a rule on the Volume Down key; pressing Volume Up clears it without waiting.
  await rpc['slots.assign']!({ ...base, index: 4, type: 'system.volume', configured: true, settings: { mode: 'down' }, appearance: { icon: { kind: 'lucide', name: 'volume-1' } } });
  await rpc['slots.update']!({ ...base, index: 4, stateRules: [muted, { source: 'volume', op: '<=', value: 0, icon: { kind: 'lucide', name: 'volume-x' } }] });
  await rpc['slots.assign']!({ ...base, index: 5, type: 'system.volume', configured: true, settings: { mode: 'up' } });
  await engine.platform.setVolume(0);
  await engine.platform.setMuted(true);
  await engine.refreshStates(true);
  assert.equal(iconName(4), 'volume-x');
  await engine.testAction(session.dev.id, 'key', 5);
  assert.equal(iconName(4), 'volume-1');

  await rpc['slots.assign']!({ ...base, kind: 'dial', index: 0, type: 'system.volume', configured: true, settings: {} });
  await rpc['slots.update']!({ ...base, kind: 'dial', index: 0, stateRules: [{ source: 'appRunning', arg: 'Zoom', op: 'is', value: true, title: 'On air', bg: '#7f1d1d' }] });
  sim.simulated['appRunning:zoom'] = true; // Matches the rule's "Zoom": case doesn't matter.
  await engine.refreshStates(true);
  assert.equal(session.zoneVisual(0).title, 'On air');
  assert.equal(session.zoneVisual(0).bg, '#7f1d1d');

  const read = await rpc['states.read']!({ keys: ['appRunning:Zoom', 'battery'] }) as Record<string, { value: unknown }>;
  assert.equal(read['appRunning:Zoom']!.value, true);
  assert.equal(read.battery!.value, 80);
  await assert.rejects(async () => rpc['states.read']!({ keys: ['nope'] }), /Unknown state/);
  assert.throws(() => rpc['slots.update']!({ ...base, index: 0, stateRules: [{ source: 'muted', op: 'is', value: 'yes', title: 'x' }] }), /true or false/);
  await rpc['slots.update']!({ ...base, index: 0, stateRules: [] });
  assert.equal(session.page()!.keys[0]!.stateRules, undefined, 'an empty list removes the rules');
});

test('macOS readers parse their command output', async () => {
  const outputs: Record<string, string> = {
    'lsappinfo front': 'ASN:0x0-0x36bf6bc:\n',
    'lsappinfo info -only name ASN:0x0-0x36bf6bc:': '"Visual Studio Code" ASN:0x0-0x36bf6bc: (in front) \n    bundleID=[ NULL ]\n',
    'lsappinfo list': ' 81) "zoom.us" ASN:0x0-0x1:\n    bundleID="us.zoom.xos"\n    bundle path="/Applications/zoom.us.app"\n'
      + ' 82) "Code" ASN:0x0-0x2: (in front)\n    bundle path="/Applications/Visual Studio Code.app"\n    executable path="/Applications/Visual Studio Code.app/Contents/MacOS/Electron"\n',
    'pmset -g batt': "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t57%; discharging; 3:10 remaining present: true\n",
    'osascript -e input volume of (get volume settings)': '0\n',
  };
  const run: CommandRunner = async (cmd, args) => {
    const key = [cmd.split('/').pop(), ...args].join(' ');
    if (key === 'defaults read -g AppleInterfaceStyle') return { code: 1, stdout: '', stderr: 'does not exist' };
    return key in outputs ? { code: 0, stdout: outputs[key]!, stderr: '' } : { code: 1, stdout: '', stderr: `unexpected ${key}` };
  };
  const mac = new MacPlatform(run);
  assert.equal(await mac.readState('frontApp'), 'Visual Studio Code');
  assert.equal(await mac.readState('appRunning', 'zoom.us'), true);
  assert.equal(await mac.readState('appRunning', ' ZOOM.US.app '), true, 'case and .app do not matter');
  assert.equal(await mac.readState('appRunning', 'Visual Studio Code'), true, 'the bundle name works when the running name differs');
  assert.equal(await mac.readState('appRunning', 'code'), true);
  assert.equal(await mac.readState('appRunning', 'Zoom'), false, 'a different name is not a match');
  assert.equal(await mac.readState('appRunning', 'Electron'), false, 'executable names are not app names');
  assert.equal(await mac.readState('battery'), 57);
  assert.equal(await mac.readState('pluggedIn'), false);
  assert.equal(await mac.readState('darkMode'), false);
  assert.equal(await mac.readState('micMuted'), true);
});
