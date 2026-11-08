// The menu bar extra. Its glyph is a 3×2 key grid drawn in code as a template image: solid when a deck
// is connected, outline when none is, and a badge when Open Smart Buttons needs the user.

import { Menu, Tray, nativeImage, type MenuItemConstructorOptions, type NativeImage } from 'electron';
import type { AppState } from '../src/shared/types.ts';

export type Glyph = 'solid' | 'outline';

/** Signed distance from (px, py) to a rounded rectangle. */
function roundedRect(px: number, py: number, x: number, y: number, w: number, h: number, r: number): number {
  const cx = x + w / 2, cy = y + h / 2;
  const qx = Math.abs(px - cx) - (w / 2 - r);
  const qy = Math.abs(py - cy) - (h / 2 - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

/** Draws the glyph at a device scale; returns a BGRA bitmap (black, alpha = coverage). */
function draw(glyph: Glyph, badge: boolean, scale: number): Buffer {
  const size = 18 * scale;
  const out = Buffer.alloc(size * size * 4);
  const key = 4.4 * scale, gap = 1.5 * scale, radius = 1.1 * scale, stroke = 1.1 * scale;
  const gridW = key * 3 + gap * 2, gridH = key * 2 + gap;
  const ox = (size - gridW) / 2 - (badge ? 0.8 * scale : 0), oy = (size - gridH) / 2 + (badge ? 0.8 * scale : 0);
  const dot = { x: size - 3.3 * scale, y: 3.3 * scale, r: 2.6 * scale };
  const S = 4;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let covered = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const px = x + (sx + 0.5) / S, py = y + (sy + 0.5) / S;
          let inside = false;
          const dDot = Math.hypot(px - dot.x, py - dot.y);
          if (badge && dDot <= dot.r) inside = true;
          else if (!badge || dDot > dot.r + 1.2 * scale) {
            for (let k = 0; k < 6 && !inside; k++) {
              const kx = ox + (k % 3) * (key + gap), ky = oy + Math.floor(k / 3) * (key + gap);
              const d = roundedRect(px, py, kx, ky, key, key, radius);
              inside = glyph === 'solid' ? d <= 0 : d <= 0 && d > -stroke;
            }
          }
          if (inside) covered++;
        }
      }
      out[(y * size + x) * 4 + 3] = Math.round((covered / (S * S)) * 255);
    }
  }
  return out;
}

const cache = new Map<string, NativeImage>();
export function glyphImage(glyph: Glyph, badge: boolean): NativeImage {
  const id = `${glyph}:${badge}`;
  let image = cache.get(id);
  if (!image) {
    image = nativeImage.createFromBitmap(draw(glyph, badge, 1), { width: 18, height: 18, scaleFactor: 1 });
    image.addRepresentation({ scaleFactor: 2, width: 36, height: 36, buffer: draw(glyph, badge, 2) });
    image.setTemplateImage(true);
    cache.set(id, image);
  }
  return image;
}

let tray: Tray | null = null;

export function setTrayVisible(visible: boolean): Tray | null {
  if (visible && !tray) {
    tray = new Tray(glyphImage('outline', false));
    tray.setToolTip('Open Smart Buttons');
  } else if (!visible && tray) {
    tray.destroy();
    tray = null;
  }
  return tray;
}

export function updateTray(glyph: Glyph, badge: boolean, menu: MenuItemConstructorOptions[]): void {
  if (!tray) return;
  tray.setImage(glyphImage(glyph, badge));
  tray.setContextMenu(Menu.buildFromTemplate(menu));
}

/** The first physical deck, which the menu bar describes and controls. */
export function primaryDevice(state: AppState | null) {
  return state?.devices.find((d) => d.kind === 'usb') ?? null;
}
