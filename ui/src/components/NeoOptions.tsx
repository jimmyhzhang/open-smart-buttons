import type { DeviceSummary, Profile } from '../../../src/shared/types.ts';
import { INFO_BAR_MODES, TOUCH_POINT_MODES, infoBarMode, touchPointMode } from '../../../src/shared/neo-options.ts';
import { act } from '../api.ts';
import { Icon } from './Icon.tsx';

/** Compact controls for the Neo's touch points and info bar, shown under the device. */
export function NeoOptions({ device, profile }: { device: DeviceSummary; profile: Profile }) {
  if (!device.touchPoints && !device.infoBar) return null;
  const tp = touchPointMode(profile.neo?.touchPoints);
  const ib = infoBarMode(profile.neo?.infoBar);
  const set = (patch: Record<string, string>) => act('profiles.setNeo', { profileId: profile.id, ...patch });
  return (
    <div className="neo-options" role="group" aria-label="Neo controls">
      {device.touchPoints ? (
        <label><Icon name="circle-dot" size={13} /><span>Touch points</span>
          <select aria-label="Touch points" value={tp} onChange={(e) => set({ touchPoints: e.target.value })}>
            {TOUCH_POINT_MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
        </label>
      ) : null}
      {device.infoBar ? (
        <label><Icon name="rectangle-horizontal" size={13} /><span>Info bar</span>
          <select aria-label="Info bar" value={ib} onChange={(e) => set({ infoBar: e.target.value })}>
            {INFO_BAR_MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
        </label>
      ) : null}
    </div>
  );
}

export function touchLabels(profile: Profile | undefined): [string, string] {
  const m = TOUCH_POINT_MODES.find((x) => x.value === touchPointMode(profile?.neo?.touchPoints))!;
  return [m.left, m.right];
}
