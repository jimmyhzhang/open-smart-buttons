// Merges the per-architecture latest-mac.yml files from the arm64 and x64 builds into one, so neither
// architecture's update entry overwrites the other's.
//   node scripts/merge-latest-mac.mjs out/latest-mac.yml arm64/latest-mac.yml x64/latest-mac.yml
import { readFileSync, writeFileSync } from 'node:fs';
import yaml from 'js-yaml';

const [output, ...inputs] = process.argv.slice(2);
if (!output || inputs.length < 2) throw new Error('Usage: merge-latest-mac.mjs OUTPUT INPUT INPUT...');
const docs = inputs.map((file) => yaml.load(readFileSync(file, 'utf8')));
const versions = new Set(docs.map((d) => d.version));
if (versions.size !== 1) throw new Error(`Builds disagree on the version: ${[...versions].join(', ')}`);
const [first] = docs;
const seen = new Set();
const files = [];
for (const doc of docs) for (const f of doc.files ?? []) if (!seen.has(f.url)) { seen.add(f.url); files.push(f); }
const merged = { ...first, files, releaseDate: docs.map((d) => d.releaseDate).sort().at(-1) };
writeFileSync(output, yaml.dump(merged, { lineWidth: -1 }));
console.log(`Merged ${files.length} update files for ${first.version}`);
