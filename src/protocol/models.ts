// Device model identifiers, geometry, and transport capabilities.
// Pure data: safe to import from Node and from the browser.

export const ELGATO_VENDOR_ID = 0x0fd9;

export type ProtocolGen = 'gen1' | 'gen2';

export interface KeyImageSpec {
  width: number;
  height: number;
  format: 'jpeg' | 'bmp';
  flipX: boolean;
  flipY: boolean;
  rotation: 0 | 90 | 180 | 270;
}

export interface LcdSpec {
  width: number;
  height: number;
}

export interface ModelInfo {
  /** Stable id used by this app. */
  id: string;
  /** Elgato codename (profile `Device.Model`). */
  codename: string;
  name: string;
  productIds: number[];
  protocol: ProtocolGen;
  columns: number;
  rows: number;
  keyImage: KeyImageSpec;
  encoders: number;
  lcd: LcdSpec | null;
  /** Capacitive touch points reported after the keys in the key input report (Neo). */
  touchPoints: number;
  /** Info bar display (Neo): 248x58 JPEG, rotated 180° on the device, written with 02 0b. */
  infoBar: LcdSpec | null;
  /** Gen-2 packet size for output reports. */
  packetSize: number;
  /** Supported by this rev's protocol implementation. */
  supported: boolean;
}

const gen2Key = (px: number, flip: boolean): KeyImageSpec => ({
  width: px, height: px, format: 'jpeg', flipX: flip, flipY: flip, rotation: 0,
});

export const MODELS: ModelInfo[] = [
  {
    id: 'plus', codename: '20GBD9901', name: 'Stream Deck +', productIds: [0x0084],
    protocol: 'gen2', columns: 4, rows: 2, keyImage: gen2Key(120, false), encoders: 4,
    lcd: { width: 800, height: 100 }, touchPoints: 0, infoBar: null, packetSize: 1024, supported: true,
  },
  {
    id: 'mk2', codename: '20GBA9901', name: 'Stream Deck MK.2', productIds: [0x0080, 0x00a5],
    protocol: 'gen2', columns: 5, rows: 3, keyImage: gen2Key(72, true), encoders: 0,
    lcd: null, touchPoints: 0, infoBar: null, packetSize: 1024, supported: true,
  },
  {
    id: 'original-v2', codename: '20GAA9902', name: 'Stream Deck (v2)', productIds: [0x006d],
    protocol: 'gen2', columns: 5, rows: 3, keyImage: gen2Key(72, true), encoders: 0,
    lcd: null, touchPoints: 0, infoBar: null, packetSize: 1024, supported: true,
  },
  {
    id: 'xl', codename: '20GAT9902', name: 'Stream Deck XL', productIds: [0x006c, 0x008f],
    protocol: 'gen2', columns: 8, rows: 4, keyImage: gen2Key(96, true), encoders: 0,
    lcd: null, touchPoints: 0, infoBar: null, packetSize: 1024, supported: true,
  },
  {
    id: 'neo', codename: '20GBJ9901', name: 'Stream Deck Neo', productIds: [0x009a],
    protocol: 'gen2', columns: 4, rows: 2, keyImage: gen2Key(96, true), encoders: 0,
    lcd: null, touchPoints: 2, infoBar: { width: 248, height: 58 }, packetSize: 1024, supported: true,
  },
  {
    id: 'mini', codename: '20GAI9901', name: 'Stream Deck Mini', productIds: [0x0063, 0x0090],
    protocol: 'gen1', columns: 3, rows: 2,
    keyImage: { width: 80, height: 80, format: 'bmp', flipX: false, flipY: true, rotation: 90 },
    encoders: 0, lcd: null, touchPoints: 0, infoBar: null, packetSize: 1024, supported: false,
  },
  {
    id: 'original', codename: '20GAA9901', name: 'Stream Deck (v1)', productIds: [0x0060],
    protocol: 'gen1', columns: 5, rows: 3,
    keyImage: { width: 72, height: 72, format: 'bmp', flipX: true, flipY: false, rotation: 0 },
    encoders: 0, lcd: null, touchPoints: 0, infoBar: null, packetSize: 8191, supported: false,
  },
  {
    id: 'pedal', codename: '20GBF9901', name: 'Stream Deck Pedal', productIds: [0x0086],
    protocol: 'gen2', columns: 3, rows: 1, keyImage: gen2Key(0, false), encoders: 0,
    lcd: null, touchPoints: 0, infoBar: null, packetSize: 1024, supported: true,
  },
];

export function modelByProductId(pid: number): ModelInfo | undefined {
  return MODELS.find((m) => m.productIds.includes(pid));
}

export function modelById(id: string): ModelInfo | undefined {
  return MODELS.find((m) => m.id === id);
}

export function modelByCodename(codename: string): ModelInfo | undefined {
  return MODELS.find((m) => m.codename === codename);
}

export function keyCount(m: ModelInfo): number {
  return m.columns * m.rows;
}

/** Width of one encoder's zone on the touch strip. */
export function lcdZoneWidth(m: ModelInfo): number {
  return m.lcd && m.encoders ? Math.floor(m.lcd.width / m.encoders) : 0;
}
