// electron-builder afterSign hook: signs the app by certificate hash (SDP_SIGN_IDENTITY) with the
// hardened runtime and the app's entitlements, before the DMG and update zip are made. Notarization,
// when configured, is run by electron-builder for Developer ID builds signed through CSC_LINK.
import { signAsync } from '@electron/osx-sign';
import { join } from 'node:path';

export default async function sign(context) {
  const identity = process.env.SDP_SIGN_IDENTITY;
  if (!identity || context.electronPlatformName !== 'darwin') return;
  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const entitlements = join(context.packager.info.projectDir, 'build', 'entitlements.mac.plist');
  await signAsync({
    app,
    identity,
    platform: 'darwin',
    optionsForFile: () => ({ hardenedRuntime: true, entitlements, timestamp: 'none' }),
  });
  console.log(`  • signed ${app}`);
}
