import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MacPlatform, type CommandRunner } from '../src/engine/platform.ts';

/** A fake osascript that models macOS output volume and its separate mute flag. */
function fakeMac(start: { volume: number | 'missing value'; muted: boolean }) {
  const audio = { ...start };
  const run: CommandRunner = async (cmd, args) => {
    const script = args.join(' ');
    if (cmd !== 'osascript') return { code: 0, stdout: '', stderr: '' };
    if (script.includes('get volume settings')) return { code: 0, stdout: `${audio.volume},${audio.muted}\n`, stderr: '' };
    const level = /set volume output volume (\d+)/.exec(script);
    if (level) audio.volume = Number(level[1]); // like macOS: does not touch the mute flag
    const mute = /set volume output muted (true|false)/.exec(script);
    if (mute) audio.muted = mute[1] === 'true';
    return { code: 0, stdout: '', stderr: '' };
  };
  return { audio, mac: new MacPlatform(run) };
}

test('macOS volume up from a muted zero level unmutes; volume down never unmutes', async () => {
  const { audio, mac } = fakeMac({ volume: 0, muted: true });
  await mac.media('volup');
  assert.deepEqual(audio, { volume: 6, muted: false });
  const quiet = fakeMac({ volume: 30, muted: true });
  await quiet.mac.media('voldown');
  assert.deepEqual(quiet.audio, { volume: 24, muted: true });
});

test('an output without adjustable volume is unknown, not zero', async () => {
  const { mac } = fakeMac({ volume: 'missing value', muted: false });
  await assert.rejects(mac.getVolume(), /no adjustable volume/);
});
