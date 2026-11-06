// The Claude API key, encrypted with safeStorage (Keychain-backed) in userData. The key never reaches
// a renderer: windows only learn whether one is stored. The Keychain is touched only when a key is
// saved or used: asking it earlier can show a Keychain prompt at launch, before any window exists.

import { safeStorage } from 'electron';
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export class SecretStore {
  private readonly file: string;

  constructor(dir: string) {
    this.file = join(dir, 'anthropic-key.bin');
  }

  available(): boolean {
    return process.platform === 'darwin' || safeStorage.isEncryptionAvailable();
  }

  get(): string | null {
    if (!existsSync(this.file)) return null;
    try {
      return safeStorage.decryptString(readFileSync(this.file)) || null;
    } catch {
      return null;
    }
  }

  has(): boolean {
    return existsSync(this.file);
  }

  /** Stores a key, or clears it with null/empty. Refuses to write plaintext. */
  set(key: string | null): void {
    const value = key?.trim();
    if (!value) {
      try { unlinkSync(this.file); } catch { /* none stored */ }
      return;
    }
    if (!/^[\x21-\x7e]{8,512}$/.test(value)) throw new Error('That does not look like an API key.');
    if (!safeStorage.isEncryptionAvailable()) throw new Error('This Mac cannot encrypt the key right now. Try again after signing in.');
    const temp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(temp, safeStorage.encryptString(value), { mode: 0o600 });
    renameSync(temp, this.file);
  }
}
