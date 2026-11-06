// Main-process log: ~/Library/Logs/StreamDeckPlus/StreamDeckPlus.log, rotated at 2 MB (one backup).
// Never pass credentials here: launch URLs carry the browser credential in their fragment.

import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';

const MAX_BYTES = 2 * 1024 * 1024;
let file = '';

export function initLog(dir: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  file = join(dir, 'StreamDeckPlus.log');
  return file;
}

export function logFile(): string {
  return file;
}

const CREDENTIAL = /(session=|Bearer\s+|auth\.)[A-Za-z0-9_-]{20,}/g;
const API_KEY = /sk-ant-[A-Za-z0-9_-]+/g;

/** Strip anything shaped like a launch credential or API key before it reaches disk. */
export function redact(text: string): string {
  return text.replace(CREDENTIAL, '$1[redacted]').replace(API_KEY, '[redacted]');
}

export function log(source: string, message: string): void {
  const line = `${new Date().toISOString()} [${source}] ${redact(message).trimEnd()}\n`;
  if (!file) { process.stderr.write(line); return; }
  try {
    try { if (statSync(file).size > MAX_BYTES) renameSync(file, `${file}.1`); } catch { /* new file */ }
    appendFileSync(file, line, { mode: 0o600 });
  } catch { process.stderr.write(line); }
}
