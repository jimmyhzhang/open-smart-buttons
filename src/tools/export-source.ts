// Copies the public source allowlist to a new directory. Ownership and license checks are separate.
import { copyFileSync, globSync, lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const output = process.argv[2];
if (!output) throw new Error('Usage: node src/tools/export-source.ts NEW_DIRECTORY');
const destination = resolve(output);
const root = realpathSync(fileURLToPath(new URL('../../', import.meta.url)));
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { files: string[] };
const files = new Set(['package.json', 'package-lock.json', 'README.md', '.gitignore', ...globSync(manifest.files, { cwd: root })]);
mkdirSync(destination, { mode: 0o700 });
for (const file of [...files].sort()) {
  const source = resolve(root, file);
  if (!source.startsWith(root + sep) || !lstatSync(source).isFile() || realpathSync(source) !== source) {
    throw new Error(`Expected a regular release file inside the workspace: ${file}`);
  }
  const target = join(destination, file);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
}
console.log(`Copied ${files.size} source files to ${destination}`);
