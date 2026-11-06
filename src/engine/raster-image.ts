import { Buffer } from 'node:buffer';

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const JPEG_FRAME = new Set([0xc0, 0xc1, 0xc2]);
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

export function checkedRaster(data: Uint8Array): 'png' | 'jpg' {
  if (data.byteLength > MAX_IMAGE_BYTES) throw new Error('Image must be at most 4 MiB.');
  const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const check = (width: number, height: number) => {
    if (width < 1 || height < 1 || width > 4096 || height > 4096 || width * height > 8_000_000) {
      throw new Error('Image exceeds the supported dimensions.');
    }
  };
  if (bytes.length >= 33 && bytes.subarray(0, 8).equals(PNG_SIGNATURE) &&
    bytes.readUInt32BE(8) === 13 && bytes.toString('ascii', 12, 16) === 'IHDR') {
    check(bytes.readUInt32BE(16), bytes.readUInt32BE(20));
    return 'png';
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    for (let pos = 2; pos + 4 < bytes.length && bytes[pos] === 0xff;) {
      while (bytes[pos] === 0xff) pos++;
      const marker = bytes[pos++];
      if (marker === undefined || marker === 0xda || marker === 0xd9 || pos + 2 > bytes.length) break;
      const length = bytes.readUInt16BE(pos);
      if (length < 2 || pos + length > bytes.length) break;
      if (JPEG_FRAME.has(marker) && length >= 8) {
        check(bytes.readUInt16BE(pos + 5), bytes.readUInt16BE(pos + 3));
        return 'jpg';
      }
      pos += length;
    }
  }
  throw new Error('Choose a valid PNG or JPEG image.');
}
