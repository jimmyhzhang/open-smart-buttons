// Draws the app icon in code (no binary assets in the source tree) and writes build/icon.icns.
//   node scripts/make-icons.mjs
import { createCanvas } from '@napi-rs/canvas';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** macOS app icon: an 824 px rounded-square body inside a 1024 canvas (Apple's grid). */
function draw(size) {
  const c = createCanvas(size, size);
  const g = c.getContext('2d');
  const s = size / 1024;
  const body = { x: 100 * s, y: 100 * s, w: 824 * s, h: 824 * s, r: 185 * s };
  const rr = (x, y, w, h, r) => { g.beginPath(); g.roundRect(x, y, w, h, r); };

  g.save();
  g.shadowColor = 'rgba(0,0,0,0.35)';
  g.shadowBlur = 28 * s;
  g.shadowOffsetY = 12 * s;
  rr(body.x, body.y, body.w, body.h, body.r);
  const chassis = g.createLinearGradient(0, body.y, 0, body.y + body.h);
  chassis.addColorStop(0, '#3a3f45');
  chassis.addColorStop(1, '#141619');
  g.fillStyle = chassis;
  g.fill();
  g.restore();

  // Subtle top highlight.
  rr(body.x, body.y, body.w, body.h, body.r);
  const sheen = g.createLinearGradient(0, body.y, 0, body.y + body.h * 0.5);
  sheen.addColorStop(0, 'rgba(255,255,255,0.10)');
  sheen.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = sheen;
  g.fill();

  // 3 x 2 keys; one lit in the app's signal teal.
  const key = 196 * s, gap = 48 * s;
  const gridW = key * 3 + gap * 2, gridH = key * 2 + gap;
  const ox = body.x + (body.w - gridW) / 2, oy = body.y + (body.h - gridH) / 2;
  for (let i = 0; i < 6; i++) {
    const x = ox + (i % 3) * (key + gap), y = oy + Math.floor(i / 3) * (key + gap);
    const lit = i === 0;
    g.save();
    if (lit) { g.shadowColor = 'rgba(45,212,191,0.65)'; g.shadowBlur = 60 * s; }
    rr(x, y, key, key, 40 * s);
    const face = g.createLinearGradient(0, y, 0, y + key);
    if (lit) { face.addColorStop(0, '#5eead4'); face.addColorStop(1, '#0d9488'); }
    else { face.addColorStop(0, '#2b3036'); face.addColorStop(1, '#1d2125'); }
    g.fillStyle = face;
    g.fill();
    g.restore();
    rr(x + 1.5 * s, y + 1.5 * s, key - 3 * s, key - 3 * s, 38 * s);
    g.strokeStyle = lit ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.07)';
    g.lineWidth = 3 * s;
    g.stroke();
  }
  return c.toBuffer('image/png');
}

const work = mkdtempSync(join(tmpdir(), 'sdp-icon-'));
try {
  const set = join(work, 'icon.iconset');
  mkdirSync(set);
  for (const base of [16, 32, 128, 256, 512]) {
    writeFileSync(join(set, `icon_${base}x${base}.png`), draw(base));
    writeFileSync(join(set, `icon_${base}x${base}@2x.png`), draw(base * 2));
  }
  mkdirSync(join(root, 'build'), { recursive: true });
  execFileSync('/usr/bin/iconutil', ['-c', 'icns', set, '-o', join(root, 'build', 'icon.icns')]);
  writeFileSync(join(root, 'build', 'icon.png'), draw(512));
  console.log('build/icon.icns written');
} finally {
  rmSync(work, { recursive: true, force: true });
}
