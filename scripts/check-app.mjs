// Verifies a packaged StreamDeckPlus.app before it ships.
//   node scripts/check-app.mjs <path/to/StreamDeckPlus.app> [--release]
// Checks: code signature, security fuses, native module architecture, archive contents, and a launch
// self-test (USB support loads, a key renders, the editor serves). --release adds Gatekeeper and stapling.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getCurrentFuseWire, FuseV1Options, FuseState } from '@electron/fuses';
import { listPackage, extractFile } from '@electron/asar';

const [appPath] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const release = process.argv.includes('--release');
if (!appPath || !existsSync(appPath)) throw new Error('Usage: node scripts/check-app.mjs <StreamDeckPlus.app> [--release]');
const failures = [];
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
};
const sh = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8' });

// 1. Signature
const verify = sh('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath]);
check('codesign --verify --deep --strict', verify.status === 0, verify.stderr.trim());
const info = sh('/usr/bin/codesign', ['-dvv', appPath]).stderr;
check('hardened runtime', /flags=0x10000\(runtime\)|runtime/.test(info));
if (release) {
  const gate = sh('/usr/sbin/spctl', ['-a', '-vv', appPath]);
  check('Gatekeeper accepts (spctl)', gate.status === 0, gate.stderr.trim());
  const staple = sh('/usr/bin/xcrun', ['stapler', 'validate', appPath]);
  check('notarization ticket stapled', staple.status === 0);
  check('Developer ID signature', /Authority=Developer ID Application/.test(info));
  const entitlements = sh('/usr/bin/codesign', ['-d', '--entitlements', ':-', appPath]);
  check('distribution library validation enabled', entitlements.status === 0 &&
    !`${entitlements.stdout}\n${entitlements.stderr}`.includes('com.apple.security.cs.disable-library-validation'));
}

// 2. Fuses
const exe = join(appPath, 'Contents', 'MacOS', 'StreamDeckPlus');
const wire = await getCurrentFuseWire(exe);
const want = {
  [FuseV1Options.RunAsNode]: FuseState.DISABLE,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: FuseState.DISABLE,
  [FuseV1Options.EnableNodeCliInspectArguments]: FuseState.DISABLE,
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: FuseState.ENABLE,
  [FuseV1Options.OnlyLoadAppFromAsar]: FuseState.ENABLE,
  [FuseV1Options.EnableCookieEncryption]: FuseState.ENABLE,
};
for (const [fuse, state] of Object.entries(want)) {
  check(`fuse ${FuseV1Options[fuse]}`, wire[fuse] === state);
}

// 3. Architecture of the app binary and every native module
const archOf = (file) => sh('/usr/bin/lipo', ['-archs', file]).stdout.trim();
const appArch = archOf(exe);
check('app binary is single-architecture', /^(arm64|x86_64)$/.test(appArch), appArch);
const unpacked = join(appPath, 'Contents', 'Resources', 'app.asar.unpacked');
const nodes = [];
const walk = (dir) => { for (const e of readdirSync(dir, { withFileTypes: true })) { const p = join(dir, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith('.node')) nodes.push(p); } };
if (existsSync(unpacked)) walk(unpacked);
check('native modules present', nodes.some((n) => n.includes('node-hid')) && nodes.some((n) => n.includes('canvas')), `${nodes.length} found`);
for (const n of nodes) check(`arch ${n.slice(unpacked.length + 1)}`, archOf(n) === appArch, archOf(n));

// 4. Archive contents
const asar = join(appPath, 'Contents', 'Resources', 'app.asar');
const files = listPackage(asar, { isPack: false });
const banned = files.filter((f) => /(^|\/)\.env|\.tgz$|\.tar\.gz$|\.mp4$|(^|\/)spike\/|(^|\/)docs\/|(^|\/)test\//.test(f));
check('no local working files in app.asar', banned.length === 0, banned.slice(0, 5).join(', '));
let leaked = '';
for (const f of files) {
  if (!/\.(ts|js|mjs|cjs|json|html|css|yml)$/.test(f) || f.includes('node_modules')) continue;
  let text = '';
  try { text = extractFile(asar, f.replace(/^\//, '')).toString('utf8'); } catch { continue; }
  if (/\/Users\/[a-z]/.test(text) || /sk-ant-[A-Za-z0-9]/.test(text)) { leaked = f; break; }
}
check('no home paths or API keys in app sources', !leaked, leaked);
const resources = join(appPath, 'Contents', 'Resources');
for (const f of ['THIRD_PARTY_NOTICES.md', 'NATIVE_NOTICES.txt', 'LICENSE.txt', 'LICENSE.electron.txt', 'LICENSES.chromium.html']) {
  check(`ships ${f}`, existsSync(join(resources, f)));
}
const updateYml = join(appPath, 'Contents', 'Resources', 'app-update.yml');
if (release) check('update channel configured', existsSync(updateYml));
if (existsSync(updateYml)) console.log(`     update channel: ${readFileSync(updateYml, 'utf8').replace(/\n/g, ' ')}`);

// 5. Launch self-test
const profile = mkdtempSync(join(tmpdir(), 'sdp-smoke-'));
try {
  const run = spawnSync(exe, ['--smoke', `--sdp-profile-dir=${profile}`], { encoding: 'utf8', timeout: 60_000, env: { HOME: process.env.HOME, PATH: '/usr/bin:/bin' } });
  const line = /SMOKE (.*)/.exec(run.stdout ?? '')?.[1];
  const result = line ? JSON.parse(line) : null;
  check('launch self-test', !!result?.ok, line ?? `no result (exit ${run.status}) ${run.stderr?.slice(-400)}`);
  check('self-test released the data lock', !existsSync(join(profile, 'data', 'server.lock')));
} finally { rmSync(profile, { recursive: true, force: true }); }

const size = execFileSync('/usr/bin/du', ['-sh', appPath], { encoding: 'utf8' }).split('\t')[0];
console.log(`     app size: ${size}`);
if (failures.length) { console.error(`\n${failures.length} check(s) failed.`); process.exit(1); }
console.log('\nAll checks passed.');

