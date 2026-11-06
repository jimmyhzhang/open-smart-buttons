// Shared canvas helpers: fonts, icon loading (lucide, uploaded images, emoji) with caching.

import { GlobalFonts, Image, loadImage, type SKRSContext2D } from '@napi-rs/canvas';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';

const require = createRequire(import.meta.url);
const lucideDir = join(dirname(require.resolve('lucide-static/package.json')), 'icons');

let fontsReady = false;
export function ensureFonts(): void {
  if (fontsReady) return;
  fontsReady = true;
  // System fonts are loaded by @napi-rs/canvas automatically on macOS. On Linux dev boxes, add a few common paths.
  for (const p of [
    '/usr/share/fonts/opentype/inter/Inter-SemiBold.otf',
    '/usr/share/fonts/opentype/inter/Inter-Regular.otf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    '/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf',
  ]) {
    if (existsSync(p)) GlobalFonts.registerFromPath(p);
  }
}

export const FONT_STACK = '"SF Pro Display", "SF Pro Text", "Helvetica Neue", Inter, "DejaVu Sans", sans-serif';
export const EMOJI_STACK = '"Apple Color Emoji", "Noto Color Emoji", "Segoe UI Emoji", sans-serif';

/** Icon reference with uploaded images resolved to a file path. */
export type ResolvedIcon =
  | { kind: 'lucide'; name: string }
  | { kind: 'image'; path: string }
  | { kind: 'emoji'; char: string }
  | { kind: 'none' };

const imgCache = new Map<string, Promise<Image | null>>();

export function lucideExists(name: string): boolean {
  return /^[a-z0-9-]+$/.test(name) && existsSync(join(lucideDir, `${name}.svg`));
}

export function lucideSvg(name: string, color: string, size: number, strokeWidth = 2): string | null {
  if (!lucideExists(name)) return null;
  const raw = readFileSync(join(lucideDir, `${name}.svg`), 'utf8');
  return raw
    .replace(/<!--.*?-->/s, '')
    .replace('stroke="currentColor"', `stroke="${color}"`)
    .replace('stroke-width="2"', `stroke-width="${strokeWidth}"`)
    .replace('width="24"', `width="${size}"`)
    .replace('height="24"', `height="${size}"`);
}

export function loadIcon(ref: ResolvedIcon, color: string, size: number): Promise<Image | null> {
  const key = JSON.stringify([ref, color, size]);
  let p = imgCache.get(key);
  if (!p) {
    p = (async () => {
      try {
        if (ref.kind === 'lucide') {
          const svg = lucideSvg(ref.name, color, size);
          return svg ? await loadImage(Buffer.from(svg)) : null;
        }
        if (ref.kind === 'image') return existsSync(ref.path) ? await loadImage(ref.path) : null;
      } catch {
        return null;
      }
      return null;
    })();
    imgCache.set(key, p);
    if (imgCache.size > 500) imgCache.delete(imgCache.keys().next().value!);
  }
  return p;
}

export function invalidateImage(path: string): void {
  for (const k of imgCache.keys()) if (k.includes(JSON.stringify(path).slice(1, -1))) imgCache.delete(k);
}

export function roundRect(ctx: SKRSContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Word-wrap to at most maxLines, honoring explicit newlines; ellipsizes the last line. */
export function wrapText(ctx: SKRSContext2D, text: string, maxWidth: number, maxLines: number): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    const words = para.split(/\s+/).filter(Boolean);
    if (!words.length) {
      out.push('');
      continue;
    }
    let line = '';
    for (const w of words) {
      const t = line ? `${line} ${w}` : w;
      if (ctx.measureText(t).width <= maxWidth || !line) line = t;
      else {
        out.push(line);
        line = w;
      }
    }
    out.push(line);
  }
  // Collapse empty spacer lines that Elgato titles use ("Screen\n\n\n\nShot").
  const lines = out.filter((l, i) => l !== '' || (i > 0 && out[i - 1] !== '')).filter((l) => l !== '');
  if (lines.length > maxLines) {
    lines.length = maxLines;
    let last = lines[maxLines - 1]!;
    while (last.length > 1 && ctx.measureText(last + '…').width > maxWidth) last = last.slice(0, -1);
    lines[maxLines - 1] = last + '…';
  }
  return lines.map((l) => {
    let s = l;
    while (s.length > 1 && ctx.measureText(s).width > maxWidth) s = s.slice(0, -1);
    return s === l ? l : s.slice(0, -1) + '…';
  });
}
