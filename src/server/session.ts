import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

export type LocalSession = ReturnType<typeof localSession>;

/** A supervisor-supplied credential must look like one we would generate (≥ 256 bits, base64url). */
function credential(value: string | undefined, label: string): string {
  if (value === undefined) return randomBytes(32).toString('base64url');
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(value)) throw new Error(`The ${label} must be a base64url string of at least 43 characters.`);
  return value;
}

export function newCredential(): string {
  return randomBytes(32).toString('base64url');
}

export function localSession(opts: { port: number; dev?: boolean; token?: string; browserToken?: string }) {
  const { port } = opts;
  const dev = !!opts.dev;
  const token = credential(opts.token, 'service token');
  const browserToken = credential(opts.browserToken, 'browser token');
  if (token === browserToken) throw new Error('The service and browser tokens must differ.');
  const host = `127.0.0.1:${port}`;
  const origin = `http://${host}`;
  const validOrigin = (value: string | undefined) =>
    value === origin || (dev && value === 'http://127.0.0.1:5173');
  const matches = (value: string | undefined, expected: string) =>
    value?.length === expected.length && timingSafeEqual(Buffer.from(value, 'latin1'), Buffer.from(expected));
  const headerToken = (req: IncomingMessage) => req.headers.authorization?.match(/^Bearer (\S+)$/)?.[1];

  return {
    token,
    browserToken,
    origin,
    validHost: (req: IncomingMessage) => req.headers.host === host,
    authorizedHttp: (req: IncomingMessage) =>
      (req.headers.origin === undefined || validOrigin(req.headers.origin)) &&
      (matches(headerToken(req), token) || matches(headerToken(req), browserToken)),
    authorizedSocket: (req: IncomingMessage) => req.headers.origin === undefined
      ? matches(headerToken(req), token)
      : validOrigin(req.headers.origin) && req.headers['sec-websocket-protocol']?.split(/,\s*/)
        .some((protocol) => protocol.startsWith('auth.') && matches(protocol.slice(5), browserToken)),
  };
}
