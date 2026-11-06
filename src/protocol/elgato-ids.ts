// Elgato profile page-directory ids (`Profiles/<ID>/`): the page UUID's 128 bits, shifted left by 2,
// written as 26 base-32 digits with the alphabet below, plus a trailing 'Z'.

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTVW';

export function pageDirToUuid(dir: string): string | null {
  const s = dir.endsWith('Z') ? dir.slice(0, -1) : dir;
  if (s.length !== 26) return null;
  let n = 0n;
  for (const ch of s) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) return null;
    n = n * 32n + BigInt(i);
  }
  const h = (n >> 2n).toString(16).padStart(32, '0');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function uuidToPageDir(uuid: string): string {
  let n = BigInt('0x' + uuid.replace(/-/g, '')) << 2n;
  let s = '';
  for (let i = 0; i < 26; i++) {
    s = ALPHABET[Number(n & 31n)] + s;
    n >>= 5n;
  }
  return s + 'Z';
}
