import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// React treats whatever an effect returns as its cleanup. An expression-bodied effect such as
// `useEffect(() => el.scrollIntoView(...))` returns a Promise in newer browsers and crashes on
// unmount ("destroy is not a function"). Effects must use a block body or return a function.
test('UI effects never implicitly return a value', () => {
  const files: string[] = [];
  const walk = (d: string) => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else if (/\.tsx?$/.test(n)) files.push(p); } };
  walk('ui/src');
  const bad = files.flatMap((f) => readFileSync(f, 'utf8').split('\n').map((l, i) => ({ f, i: i + 1, l }))
    .filter(({ l }) => /use(Layout|Insertion)?Effect\(\s*\(\)\s*=>\s*(?![{(\s]|$)/.test(l)));
  assert.deepEqual(bad.map((b) => `${b.f}:${b.i}`), []);
});
