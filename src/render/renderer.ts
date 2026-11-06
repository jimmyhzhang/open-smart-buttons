// Key and touch-strip renderer. Produces the exact JPEGs that get paged to the device.
// Touch zone layouts follow the Elgato SDK feedback layouts ($X1, $A0, $A1, $B1, $C1).

import { createCanvas, type SKRSContext2D } from '@napi-rs/canvas';
import { EMOJI_STACK, FONT_STACK, ensureFonts, loadIcon, roundRect, wrapText, type ResolvedIcon } from './canvas.ts';
import type { TitleAlign } from '../shared/types.ts';

export interface KeyVisual {
  bg: string;
  bgImage?: string | null;
  icon: ResolvedIcon;
  iconColor: string;
  title: string;
  showTitle: boolean;
  titleColor: string;
  titleSize: number;
  titleAlign: TitleAlign;
  /** Optional big value text (counters, clock, volume %). */
  value?: string;
  /** 0..1 progress bar along the bottom edge. */
  progress?: number | null;
  pressed?: boolean;
  overlay?: 'ok' | 'alert' | null;
  dim?: boolean;
}

export type TouchLayout = 'icon' | 'value' | 'bar' | 'dual' | 'canvas';

export interface TouchVisual {
  layout: TouchLayout;
  bg: string;
  accent: string;
  title: string;
  value?: string;
  indicator?: number | null;
  indicator2?: number | null;
  icon: ResolvedIcon;
  iconColor: string;
  bgImage?: string | null;
  /** Page-wide strip background, sliced per zone. */
  stripBg?: { path: string; index: number; count: number } | null;
  pressed?: boolean;
  overlay?: 'ok' | 'alert' | null;
  empty?: boolean;
}

const QUALITY = 92;

async function drawIcon(ctx: SKRSContext2D, icon: ResolvedIcon, color: string, cx: number, cy: number, size: number): Promise<boolean> {
  if (icon.kind === 'none') return false;
  if (icon.kind === 'emoji') {
    ctx.save();
    ctx.font = `${Math.round(size * 0.86)}px ${EMOJI_STACK}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#fff';
    ctx.fillText(icon.char, cx, cy + size * 0.04);
    ctx.restore();
    return true;
  }
  const img = await loadIcon(icon, color, icon.kind === 'lucide' ? size : 0);
  if (!img) return false;
  if (icon.kind === 'image') {
    // cover-fit inside the square
    const s = Math.min(size / img.width, size / img.height);
    const w = img.width * s;
    const h = img.height * s;
    ctx.drawImage(img, cx - w / 2, cy - h / 2, w, h);
  } else {
    ctx.drawImage(img, cx - size / 2, cy - size / 2, size, size);
  }
  return true;
}

async function drawBgImage(ctx: SKRSContext2D, path: string | null | undefined, w: number, h: number): Promise<void> {
  if (!path) return;
  const img = await loadIcon({ kind: 'image', path }, '', 0);
  if (!img) return;
  const s = Math.max(w / img.width, h / img.height);
  ctx.drawImage(img, (w - img.width * s) / 2, (h - img.height * s) / 2, img.width * s, img.height * s);
}

function drawOverlay(ctx: SKRSContext2D, kind: 'ok' | 'alert', w: number, h: number): void {
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillRect(0, 0, w, h);
  const s = Math.min(w, h) * 0.5;
  ctx.translate(w / 2, h / 2);
  ctx.lineWidth = s * 0.14;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (kind === 'ok') {
    ctx.strokeStyle = '#34d399';
    ctx.beginPath();
    ctx.moveTo(-s * 0.4, 0);
    ctx.lineTo(-s * 0.1, s * 0.3);
    ctx.lineTo(s * 0.45, -s * 0.3);
    ctx.stroke();
  } else {
    ctx.strokeStyle = '#f59e0b';
    ctx.beginPath();
    ctx.moveTo(0, -s * 0.45);
    ctx.lineTo(s * 0.48, s * 0.38);
    ctx.lineTo(-s * 0.48, s * 0.38);
    ctx.closePath();
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, -s * 0.12);
    ctx.lineTo(0, s * 0.1);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, s * 0.24, ctx.lineWidth * 0.4, 0, Math.PI * 2);
    ctx.fillStyle = '#f59e0b';
    ctx.fill();
  }
  ctx.restore();
}

/** Rotate/flip an encoded key image into the device's native orientation. */
export async function orientKey(jpeg: Buffer, px: number, flipX: boolean, flipY: boolean, height = px): Promise<Buffer> {
  if (!flipX && !flipY) return jpeg;
  const { loadImage } = await import('@napi-rs/canvas');
  const img = await loadImage(jpeg);
  const c = createCanvas(px, height);
  const ctx = c.getContext('2d');
  ctx.translate(flipX ? px : 0, flipY ? height : 0);
  ctx.scale(flipX ? -1 : 1, flipY ? -1 : 1);
  ctx.drawImage(img, 0, 0, px, height);
  return c.encode('jpeg', QUALITY);
}

export async function renderKey(v: KeyVisual, px: number): Promise<Buffer> {
  ensureFonts();
  const c = createCanvas(px, px);
  const ctx = c.getContext('2d');
  const k = px / 120; // design at 120 px, scale for other models
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, px, px);
  if (v.pressed) {
    // Physical-feeling press: shrink content slightly.
    ctx.translate(px / 2, px / 2);
    ctx.scale(0.92, 0.92);
    ctx.translate(-px / 2, -px / 2);
  }
  ctx.fillStyle = v.bg || '#000';
  ctx.fillRect(0, 0, px, px);
  await drawBgImage(ctx, v.bgImage, px, px);

  const hasTitle = v.showTitle && !!v.title;
  const hasValue = !!v.value;
  ctx.font = `600 ${Math.round(v.titleSize * k)}px ${FONT_STACK}`;
  const titleLines = hasTitle ? wrapText(ctx, v.title, px - 10 * k, v.titleAlign === 'middle' ? 4 : 2) : [];
  const lineH = v.titleSize * k * 1.15;
  const titleBlock = titleLines.length * lineH;

  // Icon area shrinks to leave room for title/value
  let iconSize = 64 * k;
  let iconCy = px / 2;
  if (hasTitle && v.titleAlign === 'bottom') {
    iconSize = Math.min(iconSize, px - titleBlock - 22 * k);
    iconCy = (px - titleBlock - 8 * k) / 2 + 4 * k;
  } else if (hasTitle && v.titleAlign === 'top') {
    iconSize = Math.min(iconSize, px - titleBlock - 22 * k);
    iconCy = titleBlock + 8 * k + (px - titleBlock - 8 * k) / 2 - 2 * k;
  }
  // A bottom title, a live value and a progress bar must stack without overlapping.
  const bottomTitle = hasTitle && v.titleAlign === 'bottom';
  const reserve = v.progress != null ? 7 * k : 0;
  const above = px - 7 * k - reserve - titleBlock - 2 * k; // free height above a bottom title
  if (hasValue && bottomTitle) {
    iconSize = reserve ? 0 : Math.max(0, Math.min(24 * k, above - 24 * k));
    iconCy = 5 * k + iconSize / 2;
  } else if (hasValue) {
    iconSize = Math.min(iconSize, 40 * k);
    iconCy = hasTitle && v.titleAlign === 'top' ? titleBlock + 6 * k + iconSize / 2 : 10 * k + iconSize / 2;
  }
  if (hasTitle && v.titleAlign === 'middle' && !hasValue) iconSize = 0;
  if (iconSize > 8) await drawIcon(ctx, v.icon, v.iconColor, px / 2, iconCy, iconSize);

  if (hasValue) {
    ctx.save();
    ctx.fillStyle = v.titleColor;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const drawnIcon = iconSize > 8 && v.icon.kind !== 'none';
    const valueTop = bottomTitle && drawnIcon ? iconCy + iconSize / 2 + 2 * k : 0;
    let fs = bottomTitle ? Math.min(30 * k, (above - valueTop) * 0.8) : 30 * k;
    ctx.font = `700 ${fs}px ${FONT_STACK}`;
    while (ctx.measureText(v.value!).width > px - 12 * k && fs > 12) {
      fs -= 2;
      ctx.font = `700 ${fs}px ${FONT_STACK}`;
    }
    const top = bottomTitle ? valueTop + (above - valueTop) / 2 + 2 * k : v.icon.kind === 'none' ? px / 2 : iconCy + iconSize / 2 + fs * 0.7;
    ctx.fillText(v.value!, px / 2, top);
    ctx.restore();
  }

  if (hasTitle) {
    ctx.save();
    ctx.fillStyle = v.titleColor;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `600 ${Math.round(v.titleSize * k)}px ${FONT_STACK}`;
    ctx.shadowColor = 'rgba(0,0,0,0.8)';
    ctx.shadowBlur = 3 * k;
    let y0: number;
    if (v.titleAlign === 'top') y0 = 6 * k + lineH / 2;
    else if (v.titleAlign === 'bottom') y0 = px - 7 * k - reserve - titleBlock + lineH / 2;
    else y0 = px / 2 - titleBlock / 2 + lineH / 2;
    titleLines.forEach((l, i) => ctx.fillText(l, px / 2, y0 + i * lineH));
    ctx.restore();
  }

  if (v.progress != null) {
    const p = Math.max(0, Math.min(1, v.progress));
    ctx.fillStyle = 'rgba(255,255,255,0.18)';
    roundRect(ctx, 10 * k, px - 10 * k, px - 20 * k, 4 * k, 2 * k);
    ctx.fill();
    ctx.fillStyle = v.titleColor;
    roundRect(ctx, 10 * k, px - 10 * k, Math.max(4 * k, (px - 20 * k) * p), 4 * k, 2 * k);
    ctx.fill();
  }

  if (v.dim) {
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(0, 0, px, px);
  }
  if (v.overlay) drawOverlay(ctx, v.overlay, px, px);
  return c.encode('jpeg', QUALITY);
}

export async function renderTouchZone(v: TouchVisual, w: number, h: number): Promise<Buffer> {
  ensureFonts();
  const c = createCanvas(w, h);
  const ctx = c.getContext('2d');
  ctx.fillStyle = v.bg || '#000';
  ctx.fillRect(0, 0, w, h);
  if (v.stripBg) {
    const img = await loadIcon({ kind: 'image', path: v.stripBg.path }, '', 0);
    if (img) {
      const W = w * v.stripBg.count;
      const s = Math.max(W / img.width, h / img.height);
      ctx.drawImage(img, (W - img.width * s) / 2 - v.stripBg.index * w, (h - img.height * s) / 2, img.width * s, img.height * s);
    }
  }
  await drawBgImage(ctx, v.bgImage, w, h);
  if (v.empty) return c.encode('jpeg', QUALITY);

  if (v.pressed) {
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.fillRect(0, 0, w, h);
  }

  const pad = 14;
  const titleFont = `600 17px ${FONT_STACK}`;
  const drawTitle = (x: number, y: number, maxW: number, align: 'left' | 'center' = 'left') => {
    if (!v.title) return;
    ctx.save();
    ctx.font = titleFont;
    ctx.fillStyle = '#e5e7eb';
    ctx.textBaseline = 'top';
    ctx.textAlign = align;
    const t = wrapText(ctx, v.title.replace(/\n+/g, ' '), maxW, 1)[0] ?? '';
    ctx.fillText(t, x, y);
    ctx.restore();
  };
  const drawBar = (y: number, value: number, color: string) => {
    const p = Math.max(0, Math.min(1, value));
    ctx.fillStyle = 'rgba(255,255,255,0.14)';
    roundRect(ctx, pad, y, w - pad * 2, 8, 4);
    ctx.fill();
    ctx.fillStyle = color;
    roundRect(ctx, pad, y, Math.max(8, (w - pad * 2) * p), 8, 4);
    ctx.fill();
  };
  const drawValue = (x: number, y: number, size: number, align: 'left' | 'right' | 'center') => {
    if (!v.value) return;
    ctx.save();
    ctx.fillStyle = '#fff';
    ctx.textAlign = align;
    ctx.textBaseline = 'middle';
    let fs = size;
    ctx.font = `700 ${fs}px ${FONT_STACK}`;
    while (ctx.measureText(v.value).width > w * 0.55 && fs > 12) {
      fs -= 2;
      ctx.font = `700 ${fs}px ${FONT_STACK}`;
    }
    ctx.fillText(v.value, x, y);
    ctx.restore();
  };

  switch (v.layout) {
    case 'icon': // $X1: icon centered, title below
      await drawIcon(ctx, v.icon, v.iconColor, w / 2, v.title ? 40 : h / 2, 48);
      if (v.title) drawTitle(w / 2, 70, w - pad * 2, 'center');
      break;
    case 'canvas': // $A0: full-bleed icon/image
      await drawIcon(ctx, v.icon, v.iconColor, w / 2, h / 2, Math.min(w, h) - 8);
      break;
    case 'value': // $A1: title, icon, value
      drawTitle(pad, 10, w - pad * 2);
      await drawIcon(ctx, v.icon, v.iconColor, pad + 24, 62, 44);
      drawValue(w - pad, 62, 34, 'right');
      break;
    case 'dual': // $C1: two indicators
      drawTitle(pad, 8, w - pad * 2);
      drawValue(w - pad, 18, 18, 'right');
      drawBar(46, v.indicator ?? 0, v.accent);
      drawBar(72, v.indicator2 ?? 0, '#60a5fa');
      break;
    case 'bar': // $B1: title, icon, value, indicator bar
    default:
      drawTitle(pad, 10, w - pad * 2);
      await drawIcon(ctx, v.icon, v.iconColor, pad + 20, 52, 36);
      drawValue(w - pad, 52, 28, 'right');
      drawBar(80, v.indicator ?? 0, v.accent);
      break;
  }

  if (v.overlay) drawOverlay(ctx, v.overlay, w, h);
  return c.encode('jpeg', QUALITY);
}

/** Separator lines between touch zones are drawn into each zone's right edge for a crisp look. */
export async function renderSolid(w: number, h: number, color = '#000'): Promise<Buffer> {
  const c = createCanvas(w, h);
  const ctx = c.getContext('2d');
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, w, h);
  return c.encode('jpeg', QUALITY);
}

export interface InfoBarVisual {
  time: string;
  date: string;
  pageName: string;
  pageIndex: number;
  pageCount: number;
  inFolder: boolean;
  mode?: 'clock' | 'page' | 'off';
}

/** Neo info bar, modeled on the app's default DigitalTime + Pagination infobar layouts. Upright image. */
export async function renderInfoBar(v: InfoBarVisual, w: number, h: number): Promise<Buffer> {
  ensureFonts();
  const c = createCanvas(w, h);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);
  if (v.mode === 'off') return c.encode('jpeg', QUALITY);
  const dots = (cx: number, cy: number, align: 'right' | 'center') => {
    const n = Math.min(v.pageCount, 8);
    const gap = 10;
    const start = align === 'right' ? cx - (n - 1) * gap - 3 : cx - ((n - 1) * gap) / 2;
    for (let i = 0; i < n; i++) {
      ctx.beginPath();
      ctx.arc(start + i * gap, cy, i === v.pageIndex ? 3.5 : 2.5, 0, Math.PI * 2);
      ctx.fillStyle = i === v.pageIndex ? '#fff' : '#4b5563';
      ctx.fill();
    }
  };
  if (v.mode === 'page') {
    ctx.fillStyle = '#fff';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    let size = 24;
    let name = (v.inFolder ? '▸ ' : '') + v.pageName;
    ctx.font = `700 ${size}px ${FONT_STACK}`;
    while (size > 13 && ctx.measureText(name).width > w - 20) { size -= 1; ctx.font = `700 ${size}px ${FONT_STACK}`; }
    while (name.length > 1 && ctx.measureText(name).width > w - 20) name = name.slice(0, -1);
    ctx.fillText(name, w / 2, h / 2 - 6);
    dots(w / 2, h - 9, 'center');
    return c.encode('jpeg', QUALITY);
  }
  ctx.fillStyle = '#fff';
  ctx.textBaseline = 'middle';
  ctx.font = `700 26px ${FONT_STACK}`;
  ctx.textAlign = 'left';
  ctx.fillText(v.time, 10, h / 2 - 7);
  ctx.font = `500 12px ${FONT_STACK}`;
  ctx.fillStyle = '#9ca3af';
  ctx.fillText(v.date, 11, h / 2 + 15);
  // right side: page name + dots
  const rx = w - 10;
  ctx.textAlign = 'right';
  ctx.fillStyle = '#e5e7eb';
  ctx.font = `600 13px ${FONT_STACK}`;
  let name = (v.inFolder ? '▸ ' : '') + v.pageName;
  while (name.length > 1 && ctx.measureText(name).width > w * 0.45) name = name.slice(0, -1);
  ctx.fillText(name, rx, h / 2 - 8);
  dots(rx, h / 2 + 13, 'right');
  return c.encode('jpeg', QUALITY);
}
