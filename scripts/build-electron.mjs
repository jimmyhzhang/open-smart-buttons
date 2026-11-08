// Packages Open Smart Buttons for Mac with electron-builder.
//   node scripts/build-electron.mjs            unpacked .app for this Mac's architecture (dist-app/mac*/)
//   node scripts/build-electron.mjs --dmg      also the DMG and update zip
//   node scripts/build-electron.mjs --dist     release: requires Developer ID signing and notarization
//   --arch arm64|x64                           target architecture (build each on its native runner)
//
// Signing: CSC_LINK/CSC_KEY_PASSWORD or CSC_NAME select the identity (electron-builder's variables).
// Without them a local build uses the first valid Developer ID Application identity in the keychain,
// else an Apple Development identity, else an ad-hoc signature. Notarization runs when APPLE_API_KEY,
// APPLE_API_KEY_ID and APPLE_API_ISSUER are set and the app is signed with a Developer ID identity. An update channel is built in when OSB_GITHUB_OWNER and
// OSB_GITHUB_REPO name the GitHub repository whose Releases host updates.
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, Platform, Arch } from 'electron-builder';
import base from '../electron-builder.config.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const arch = args[args.indexOf('--arch') + 1] && args.includes('--arch') ? args[args.indexOf('--arch') + 1] : process.arch;
if (arch !== 'arm64' && arch !== 'x64') throw new Error('--arch must be arm64 or x64');
const dist = flag('dist');
const run = (cmd, argv) => execFileSync(cmd, argv, { cwd: root, stdio: 'inherit' });

/** Valid code-signing identities in the keychain: [{ hash, name }]. Revoked or expired ones are skipped. */
function identities() {
  let out = '';
  try { out = execFileSync('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' }); } catch { /* none */ }
  return [...out.matchAll(/^\s*\d+\) ([0-9A-F]{40}) "([^"]+)"(.*)$/gm)]
    .filter((m) => !/CSSMERR|REVOKED|EXPIRED/i.test(m[3]))
    .map((m) => ({ hash: m[1], name: m[2] }));
}

const config = structuredClone(base);
const env = process.env;
const notarize = Boolean(env.APPLE_API_KEY && env.APPLE_API_KEY_ID && env.APPLE_API_ISSUER);
if (!env.CSC_LINK && !env.CSC_NAME) {
  const found = identities();
  const pick = found.find((i) => i.name.startsWith('Developer ID Application:'))
    ?? (dist ? null : found.find((i) => i.name.startsWith('Apple Development:')));
  if (!pick && dist) throw new Error('A release build needs a Developer ID Application certificate (set CSC_LINK or install one).');
  if (pick && (dist || (notarize && pick.name.startsWith('Developer ID Application:')))) {
    // electron-builder signs and notarizes release builds itself.
    config.mac.identity = pick.name.replace(/^Developer ID Application: /, '');
  } else if (pick) {
    // Sign by certificate hash (see the afterSign hook): names can be ambiguous when an old,
    // revoked certificate with the same name is still in the keychain.
    config.mac.identity = null;
    config.afterSign = join(root, 'scripts', 'sign-app.mjs');
    process.env.OSB_SIGN_IDENTITY = pick.hash;
    console.log(`Signing with ${pick.name}${pick.name.startsWith('Apple Development') ? ' (fine on this Mac, not for distribution)' : ''}.`);
  } else {
    config.mac.identity = '-';
    config.mac.entitlements = 'build/entitlements.adhoc.mac.plist';
    config.mac.entitlementsInherit = config.mac.entitlements;
    console.warn('No signing identity found: ad-hoc signing. macOS will ask for permissions again after each build.');
  }
}
if (dist && !notarize) throw new Error('A release build is notarized: set APPLE_API_KEY, APPLE_API_KEY_ID and APPLE_API_ISSUER.');
config.mac.notarize = notarize;
if (env.OSB_GITHUB_OWNER && env.OSB_GITHUB_REPO) {
  config.publish = { provider: 'github', owner: env.OSB_GITHUB_OWNER, repo: env.OSB_GITHUB_REPO, releaseType: 'draft' };
} else if (dist) {
  throw new Error('A release build needs an update channel: set OSB_GITHUB_OWNER and OSB_GITHUB_REPO.');
}
if (!flag('dmg') && !dist) config.mac.target = [{ target: 'dir' }];
// Ship only this architecture's USB prebuild (canvas installs per architecture already).
config.files = [...config.files, `!**/node_modules/node-hid/prebuilds/HID-darwin-${arch === 'arm64' ? 'x64' : 'arm64'}/**`];

run('npm', ['run', 'build:ui']);
run(process.execPath, [join(root, 'scripts', 'make-icons.mjs')]);
run(process.execPath, [join(root, 'scripts', 'native-notices.mjs')]);

const out = await build({
  projectDir: root,
  config,
  targets: Platform.MAC.createTarget(null, arch === 'arm64' ? Arch.arm64 : Arch.x64),
  publish: 'never',
});
console.log(out.join('\n'));
