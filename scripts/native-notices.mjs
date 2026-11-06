// Writes build/NATIVE_NOTICES.txt: the components compiled into the app's native modules, from the
// @napi-rs/canvas SBOM and node-hid's bundled hidapi, with their declared licenses. The app ships it
// next to THIRD_PARTY_NOTICES.md (electron-builder extraResources).
//   node scripts/native-notices.mjs
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const nm = join(root, 'node_modules');
const lines = [
  'StreamDeckPlus for Mac: notices for native components',
  '',
  'The app bundles prebuilt native modules. Their compiled-in components and declared licenses follow.',
  'Electron and Chromium notices are in LICENSE.electron.txt and LICENSES.chromium.html in this folder.',
  '',
];

const canvasDir = readdirSync(join(nm, '@napi-rs')).find((d) => d.startsWith('canvas-darwin-'));
const sbomPath = canvasDir && join(nm, '@napi-rs', canvasDir, 'sbom.cdx.json');
if (!sbomPath || !existsSync(sbomPath)) throw new Error('The @napi-rs/canvas platform package (with sbom.cdx.json) is not installed.');
const sbom = JSON.parse(readFileSync(sbomPath, 'utf8'));
lines.push(`== @napi-rs/canvas (${canvasDir}) — MIT; Skia — BSD-3-Clause (https://skia.org/)`, '');
for (const c of sbom.components ?? []) {
  const licenses = (c.licenses ?? []).map((l) => l.expression ?? l.license?.id ?? l.license?.name).filter(Boolean).join(' AND ') || 'see upstream project';
  lines.push(`${c.name}${c.version ? ` ${c.version}` : ''} — ${licenses}`);
}

const hid = join(nm, 'node-hid', 'hidapi');
lines.push('', '== node-hid — MIT OR X11; hidapi — used under its BSD-style license (one of three offered)', '');
for (const f of ['LICENSE.txt', 'LICENSE-bsd.txt']) {
  if (existsSync(join(hid, f))) lines.push(`--- hidapi/${f} ---`, readFileSync(join(hid, f), 'utf8').trim(), '');
}

mkdirSync(join(root, 'build'), { recursive: true });
writeFileSync(join(root, 'build', 'NATIVE_NOTICES.txt'), lines.join('\n') + '\n');
console.log('build/NATIVE_NOTICES.txt written');
