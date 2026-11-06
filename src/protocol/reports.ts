// Gen-2 Stream Deck HID reports (Stream Deck +, MK.2, XL v2, ...).
// Pure TypeScript over Uint8Array, shared by the device driver, the simulator and the browser UI.

export const FEATURE_REPORT_SIZE = 32;
export const INPUT_REPORT_SIZE = 512;

export const ReportId = {
  Input: 0x01,
  Output: 0x02,
  FeatureSet: 0x03,
  FeatureFirmware: 0x05,
  FeatureSerial: 0x06,
} as const;

export const OutputCommand = {
  KeyImage: 0x07,
  /** Neo info bar (248x58 JPEG, rotated 180°). Same layout as rust-elgato-streamdeck `write_lcd_fill` and
   *  node-elgato-stream-deck `StreamdeckNeoLcdImageHeaderGenerator`. */
  InfoBar: 0x0b,
  FullImage: 0x09,
  LcdRegion: 0x0c,
} as const;

export const FeatureCommand = {
  Reset: 0x02,
  Brightness: 0x08,
  SleepDelay: 0x0d,
} as const;

export const InputKind = {
  Keys: 0x00,
  Touch: 0x02,
  Encoder: 0x03,
} as const;

export const KEY_IMAGE_HEADER = 8;
export const LCD_IMAGE_HEADER = 16;

// ---------------------------------------------------------------------------------------------
// Little-endian helpers

function le16(buf: Uint8Array, off: number, v: number): void {
  buf[off] = v & 0xff;
  buf[off + 1] = (v >> 8) & 0xff;
}
function rd16(buf: Uint8Array, off: number): number {
  return (buf[off] ?? 0) | ((buf[off + 1] ?? 0) << 8);
}

// ---------------------------------------------------------------------------------------------
// Feature reports (host → device)

function feature(cmd: number, ...payload: number[]): Uint8Array {
  const b = new Uint8Array(FEATURE_REPORT_SIZE);
  b[0] = ReportId.FeatureSet;
  b[1] = cmd;
  payload.forEach((v, i) => (b[2 + i] = v & 0xff));
  return b;
}

export function encodeBrightness(percent: number): Uint8Array {
  const pct = Math.max(0, Math.min(100, Math.round(percent)));
  return feature(FeatureCommand.Brightness, pct);
}

export function encodeReset(): Uint8Array {
  return feature(FeatureCommand.Reset);
}

/** Sleep delay in seconds (0 disables sleep). u32 little-endian. */
export function encodeSleepDelay(seconds: number): Uint8Array {
  const s = Math.max(0, Math.floor(seconds)) >>> 0;
  return feature(FeatureCommand.SleepDelay, s, s >>> 8, s >>> 16, s >>> 24);
}

/** Touch-point LED color (Neo): 03 06 <index> <r> <g> <b>. */
export function encodeTouchPointColor(index: number, r: number, g: number, b: number): Uint8Array {
  return feature(0x06, index, r, g, b);
}

export type FeatureSet =
  | { cmd: 'reset' }
  | { cmd: 'brightness'; percent: number }
  | { cmd: 'sleepDelay'; seconds: number }
  | { cmd: 'unknown'; code: number; bytes: Uint8Array };

export function decodeFeatureSet(b: Uint8Array): FeatureSet {
  if (b[0] !== ReportId.FeatureSet) return { cmd: 'unknown', code: -1, bytes: b };
  switch (b[1]) {
    case FeatureCommand.Reset:
      return { cmd: 'reset' };
    case FeatureCommand.Brightness:
      return { cmd: 'brightness', percent: b[2] ?? 0 };
    case FeatureCommand.SleepDelay:
      return { cmd: 'sleepDelay', seconds: ((b[2] ?? 0) | ((b[3] ?? 0) << 8) | ((b[4] ?? 0) << 16) | ((b[5] ?? 0) << 24)) >>> 0 };
    default:
      return { cmd: 'unknown', code: b[1] ?? -1, bytes: b };
  }
}

// Feature reports (device → host): firmware (0x05) and serial (0x06)

function ascii(b: Uint8Array, from: number): string {
  let s = '';
  for (let i = from; i < b.length; i++) {
    const c = b[i]!;
    if (c === 0) break;
    if (c >= 0x20 && c < 0x7f) s += String.fromCharCode(c);
  }
  return s.trim();
}

export function decodeFirmware(b: Uint8Array): string {
  return ascii(b, 6);
}
export function decodeSerial(b: Uint8Array): string {
  return ascii(b, 2);
}
export function encodeFirmwareReply(version: string): Uint8Array {
  const b = new Uint8Array(FEATURE_REPORT_SIZE);
  b[0] = ReportId.FeatureFirmware;
  for (let i = 0; i < version.length && 6 + i < b.length; i++) b[6 + i] = version.charCodeAt(i);
  return b;
}
export function encodeSerialReply(serial: string): Uint8Array {
  const b = new Uint8Array(FEATURE_REPORT_SIZE);
  b[0] = ReportId.FeatureSerial;
  b[1] = Math.min(serial.length, FEATURE_REPORT_SIZE - 2);
  for (let i = 0; i < serial.length && 2 + i < b.length; i++) b[2 + i] = serial.charCodeAt(i);
  return b;
}

// ---------------------------------------------------------------------------------------------
// Output reports: paged JPEG uploads

/** Split a key image into 0x02 0x07 pages. */
export function encodeKeyImagePages(key: number, image: Uint8Array, packetSize = 1024): Uint8Array[] {
  const chunk = packetSize - KEY_IMAGE_HEADER;
  const pages: Uint8Array[] = [];
  let page = 0;
  let off = 0;
  do {
    const len = Math.min(chunk, image.length - off);
    const last = off + len >= image.length;
    const b = new Uint8Array(packetSize);
    b[0] = ReportId.Output;
    b[1] = OutputCommand.KeyImage;
    b[2] = key;
    b[3] = last ? 1 : 0;
    le16(b, 4, len);
    le16(b, 6, page);
    b.set(image.subarray(off, off + len), KEY_IMAGE_HEADER);
    pages.push(b);
    off += len;
    page++;
  } while (off < image.length);
  return pages;
}

/** Split a Neo info-bar image into 02 0b pages: 02 0b 00 <last> <len LE16> <page LE16>. */
export function encodeInfoBarPages(image: Uint8Array, packetSize = 1024): Uint8Array[] {
  const chunk = packetSize - KEY_IMAGE_HEADER;
  const pages: Uint8Array[] = [];
  let page = 0;
  let off = 0;
  do {
    const len = Math.min(chunk, image.length - off);
    const b = new Uint8Array(packetSize);
    b[0] = ReportId.Output;
    b[1] = OutputCommand.InfoBar;
    b[2] = 0;
    b[3] = off + len >= image.length ? 1 : 0;
    le16(b, 4, len);
    le16(b, 6, page);
    b.set(image.subarray(off, off + len), KEY_IMAGE_HEADER);
    pages.push(b);
    off += len;
    page++;
  } while (off < image.length);
  return pages;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Split an LCD region image into 0x02 0x0c pages. */
export function encodeLcdPages(rect: Rect, image: Uint8Array, packetSize = 1024): Uint8Array[] {
  const chunk = packetSize - LCD_IMAGE_HEADER;
  const pages: Uint8Array[] = [];
  let page = 0;
  let off = 0;
  do {
    const len = Math.min(chunk, image.length - off);
    const last = off + len >= image.length;
    const b = new Uint8Array(packetSize);
    b[0] = ReportId.Output;
    b[1] = OutputCommand.LcdRegion;
    le16(b, 2, rect.x);
    le16(b, 4, rect.y);
    le16(b, 6, rect.width);
    le16(b, 8, rect.height);
    b[10] = last ? 1 : 0;
    le16(b, 11, page);
    le16(b, 13, len);
    b[15] = 0;
    b.set(image.subarray(off, off + len), LCD_IMAGE_HEADER);
    pages.push(b);
    off += len;
    page++;
  } while (off < image.length);
  return pages;
}

export type OutputPage =
  | { cmd: 'keyImage'; key: number; last: boolean; page: number; data: Uint8Array }
  | { cmd: 'lcd'; rect: Rect; last: boolean; page: number; data: Uint8Array }
  | { cmd: 'fullImage'; last: boolean; page: number; data: Uint8Array }
  | { cmd: 'infoBar'; last: boolean; page: number; data: Uint8Array }
  | { cmd: 'unknown'; code: number };

export function decodeOutputPage(b: Uint8Array): OutputPage {
  if (b[0] !== ReportId.Output) return { cmd: 'unknown', code: -1 };
  switch (b[1]) {
    case OutputCommand.KeyImage: {
      const len = rd16(b, 4);
      return { cmd: 'keyImage', key: b[2]!, last: b[3] === 1, page: rd16(b, 6), data: b.subarray(KEY_IMAGE_HEADER, KEY_IMAGE_HEADER + len) };
    }
    case OutputCommand.LcdRegion: {
      const len = rd16(b, 13);
      return {
        cmd: 'lcd',
        rect: { x: rd16(b, 2), y: rd16(b, 4), width: rd16(b, 6), height: rd16(b, 8) },
        last: b[10] === 1,
        page: rd16(b, 11),
        data: b.subarray(LCD_IMAGE_HEADER, LCD_IMAGE_HEADER + len),
      };
    }
    case OutputCommand.InfoBar: {
      const len = rd16(b, 4);
      return { cmd: 'infoBar', last: b[3] === 1, page: rd16(b, 6), data: b.subarray(KEY_IMAGE_HEADER, KEY_IMAGE_HEADER + len) };
    }
    case OutputCommand.FullImage: {
      const len = rd16(b, 4);
      return { cmd: 'fullImage', last: b[3] === 1, page: rd16(b, 6), data: b.subarray(KEY_IMAGE_HEADER, KEY_IMAGE_HEADER + len) };
    }
    default:
      return { cmd: 'unknown', code: b[1] ?? -1 };
  }
}

/** Reassembles paged uploads (used by the simulator and by the real-device mirror). */
export class PageAssembler {
  private parts = new Map<string, Uint8Array[]>();

  /** Returns the completed image when the last page arrives. */
  push(
    p: OutputPage,
  ): { target: 'key'; key: number; image: Uint8Array } | { target: 'lcd'; rect: Rect; image: Uint8Array } | { target: 'infoBar'; image: Uint8Array } | null {
    if (p.cmd === 'unknown' || p.cmd === 'fullImage') return null;
    const k = p.cmd === 'keyImage' ? `k${p.key}` : p.cmd === 'infoBar' ? 'ib' : `l${p.rect.x},${p.rect.y},${p.rect.width},${p.rect.height}`;
    let list = this.parts.get(k);
    if (p.page === 0 || !list) list = [];
    list.push(p.data.slice());
    this.parts.set(k, list);
    if (!p.last) return null;
    this.parts.delete(k);
    const total = list.reduce((a, c) => a + c.length, 0);
    const image = new Uint8Array(total);
    let o = 0;
    for (const c of list) {
      image.set(c, o);
      o += c.length;
    }
    if (p.cmd === 'infoBar') return { target: 'infoBar', image };
    return p.cmd === 'keyImage' ? { target: 'key', key: p.key, image } : { target: 'lcd', rect: p.rect, image };
  }
}

// ---------------------------------------------------------------------------------------------
// Input reports (device → host)

export type TouchType = 'tap' | 'long' | 'swipe';

export type InputReport =
  | { kind: 'keys'; states: boolean[] }
  | { kind: 'touch'; type: TouchType; x: number; y: number; x2?: number; y2?: number }
  | { kind: 'encoderPress'; states: boolean[] }
  | { kind: 'encoderRotate'; deltas: number[] }
  | { kind: 'unknown'; bytes: Uint8Array };

export function decodeInput(b: Uint8Array, keys: number, encoders: number): InputReport {
  // hidapi includes the report id as byte 0 when the device uses numbered reports.
  if (b[0] !== ReportId.Input || b.length < 4) return { kind: 'unknown', bytes: b };
  switch (b[1]) {
    case InputKind.Keys: {
      // A partial state snapshot must not release keys that are absent from the packet.
      if (b.length < 4 + keys) return { kind: 'unknown', bytes: b };
      const states: boolean[] = [];
      for (let i = 0; i < keys; i++) states.push((b[4 + i] ?? 0) !== 0);
      return { kind: 'keys', states };
    }
    case InputKind.Touch: {
      if (b.length < 10) return { kind: 'unknown', bytes: b };
      const t = b[4];
      const type: TouchType | null = t === 1 ? 'tap' : t === 2 ? 'long' : t === 3 ? 'swipe' : null;
      if (!type) return { kind: 'unknown', bytes: b };
      if (type === 'swipe' && b.length < 14) return { kind: 'unknown', bytes: b };
      const r: InputReport = { kind: 'touch', type, x: rd16(b, 6), y: rd16(b, 8) };
      if (type === 'swipe') {
        r.x2 = rd16(b, 10);
        r.y2 = rd16(b, 12);
      }
      return r;
    }
    case InputKind.Encoder: {
      if (b.length < 5 + encoders) return { kind: 'unknown', bytes: b };
      const sub = b[4];
      if (sub === 0x00) {
        const states: boolean[] = [];
        for (let i = 0; i < encoders; i++) states.push((b[5 + i] ?? 0) !== 0);
        return { kind: 'encoderPress', states };
      }
      if (sub === 0x01) {
        const deltas: number[] = [];
        for (let i = 0; i < encoders; i++) {
          const v = b[5 + i] ?? 0;
          deltas.push(v > 127 ? v - 256 : v);
        }
        return { kind: 'encoderRotate', deltas };
      }
      return { kind: 'unknown', bytes: b };
    }
    default:
      return { kind: 'unknown', bytes: b };
  }
}

function inputBase(kind: number, len: number): Uint8Array {
  const b = new Uint8Array(INPUT_REPORT_SIZE);
  b[0] = ReportId.Input;
  b[1] = kind;
  le16(b, 2, len);
  return b;
}

export function encodeKeysInput(states: boolean[]): Uint8Array {
  const b = inputBase(InputKind.Keys, states.length);
  states.forEach((s, i) => (b[4 + i] = s ? 1 : 0));
  return b;
}

export function encodeTouchInput(type: TouchType, x: number, y: number, x2 = 0, y2 = 0): Uint8Array {
  const b = inputBase(InputKind.Touch, 14);
  b[4] = type === 'tap' ? 1 : type === 'long' ? 2 : 3;
  le16(b, 6, Math.round(x));
  le16(b, 8, Math.round(y));
  if (type === 'swipe') {
    le16(b, 10, Math.round(x2));
    le16(b, 12, Math.round(y2));
  }
  return b;
}

export function encodeEncoderPressInput(states: boolean[]): Uint8Array {
  const b = inputBase(InputKind.Encoder, 5);
  b[4] = 0x00;
  states.forEach((s, i) => (b[5 + i] = s ? 1 : 0));
  return b;
}

export function encodeEncoderRotateInput(deltas: number[]): Uint8Array {
  const b = inputBase(InputKind.Encoder, 5);
  b[4] = 0x01;
  deltas.forEach((d, i) => (b[5 + i] = Math.max(-128, Math.min(127, Math.round(d))) & 0xff));
  return b;
}

// ---------------------------------------------------------------------------------------------
// Human-readable summaries for the protocol inspector

export function hexPreview(b: Uint8Array, n = 20): string {
  return [...b.subarray(0, n)].map((x) => x.toString(16).padStart(2, '0')).join(' ');
}

export function summarizeReport(dir: 'out' | 'feature' | 'in', b: Uint8Array, keys = 8, encoders = 4): string {
  if (dir === 'feature') {
    const f = decodeFeatureSet(b);
    if (f.cmd === 'brightness') return `SET brightness=${f.percent}%`;
    if (f.cmd === 'sleepDelay') return `SET sleepDelay=${f.seconds}s`;
    if (f.cmd === 'reset') return 'SET reset';
    return `SET 0x${(f.code & 0xff).toString(16)}`;
  }
  if (dir === 'out') {
    const p = decodeOutputPage(b);
    if (p.cmd === 'keyImage') return `KEY ${p.key} page ${p.page}${p.last ? ' (last)' : ''} ${p.data.length}B`;
    if (p.cmd === 'infoBar') return `INFOBAR page ${p.page}${p.last ? ' (last)' : ''} ${p.data.length}B`;
    if (p.cmd === 'lcd') return `LCD x=${p.rect.x} y=${p.rect.y} ${p.rect.width}×${p.rect.height} page ${p.page}${p.last ? ' (last)' : ''} ${p.data.length}B`;
    return `OUT 0x${p.cmd === 'unknown' ? p.code.toString(16) : '09'}`;
  }
  const r = decodeInput(b, keys, encoders);
  switch (r.kind) {
    case 'keys':
      return `KEYS [${r.states.map((s) => (s ? '■' : '·')).join('')}]`;
    case 'encoderRotate':
      return `DIAL rotate [${r.deltas.join(', ')}]`;
    case 'encoderPress':
      return `DIAL press [${r.states.map((s) => (s ? '■' : '·')).join('')}]`;
    case 'touch':
      return `TOUCH ${r.type} (${r.x},${r.y})${r.type === 'swipe' ? ` → (${r.x2},${r.y2})` : ''}`;
    default:
      return 'IN unknown';
  }
}
