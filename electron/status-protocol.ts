import { protocol } from 'electron';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const STATUS_URL = 'osb://status/status.html';

export function registerStatusScheme(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: 'osb', privileges: { standard: true, secure: true } }]);
}

export function isStatusUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'osb:' && url.host === 'status' && !url.username && !url.password && url.pathname === '/status.html';
  } catch { return false; }
}

export function statusUrl(view: string): string {
  return `${STATUS_URL}?view=${encodeURIComponent(view)}`;
}

/** Keep recovery screens loadable with restricted file-protocol privileges. */
export function installStatusProtocol(here: string): void {
  const assets = [
    ['status.html', 'text/html'], ['status.css', 'text/css'], ['status.js', 'text/javascript'],
  ] as const;
  const files = new Map(assets.map(([file, type]) => ['/' + file, {
    body: new Uint8Array(readFileSync(join(here, file))), type: `${type}; charset=utf-8`,
  }] as const));
  protocol.handle('osb', request => {
    const url = new URL(request.url);
    const file = url.host === 'status' && !url.username && !url.password ? files.get(url.pathname) : undefined;
    if (!file) return new Response('Not found', { status: 404 });
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405 });
    return new Response(request.method === 'HEAD' ? null : file.body, { headers: {
      'Content-Type': file.type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    } });
  });
}
