import { createHmac } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns';
import { request } from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';

/**
 * Plan 09 section 5 and the receiver contract of 2026-11-03: how a notice is signed, which
 * endpoint addresses NOLON may call, and the one HTTPS POST that sends it.
 */

/** What the receiver answered: its HTTP status, or none and why (refused, timeout, network). */
export interface DeliveryResult {
  status: number | null;
  error: string | null;
  /** The answer's body, at most 2 KB (read only for notices whose answer carries a result). */
  body?: string;
}

/** The most of an answer's body kept. */
const MAX_ANSWER_BYTES = 2048;

export interface NoticeTransport {
  send(url: string, headers: Record<string, string>, body: Buffer): Promise<DeliveryResult>;
}

/** The whole exchange, connect to answer, may take this long (the receiver answers in ~6 s). */
export const DELIVERY_TIMEOUT_MS = 10_000;

/**
 * HMAC-SHA256, base64url without padding, over `v1\n<audience>\n<key id>\n<timestamp>\n<body>`:
 * the receiver's signature (contract test vector in webhook-delivery.spec.ts).
 */
export function signNotice(
  secret: string,
  audience: string,
  keyId: string,
  timestamp: number,
  body: Buffer,
): string {
  return createHmac('sha256', secret)
    .update(`v1\n${audience}\n${keyId}\n${timestamp}\n`)
    .update(body)
    .digest('base64url');
}

/** The headers of a signed notice sent at `timestamp` (unix seconds). */
export function noticeHeaders(
  secret: string,
  audience: string,
  keyId: string,
  timestamp: number,
  body: Buffer,
): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'X-Nolon-Timestamp': String(timestamp),
    'X-Nolon-Key-Id': keyId,
    'X-Nolon-Signature': signNotice(secret, audience, keyId, timestamp, body),
  };
}

/** Addresses never called: private, shared, loopback, link-local, multicast, documentation. */
const blocked = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blocked.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  blocked.addSubnet(net, prefix, 'ipv6');
}

/** A public unicast address NOLON may connect to. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return isPublicAddress(mapped[1]!);
  // An IPv4-mapped address in hex form: refused rather than decoded. (BlockList matches IPv4
  // against a ::ffff:0:0/96 rule too, so that rule cannot be listed.)
  if (/^::ffff:/i.test(address)) return false;
  return !blocked.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

export type EndpointUrlProblem =
  'INVALID_URL' | 'NOT_HTTPS' | 'NOT_PORT_443' | 'IP_HOST' | 'HOST_NOT_ALLOWED';

/**
 * An endpoint address an Administrator may add: https on port 443, a host name (never an IP) in
 * the allowed list, no credentials or fragment. Returns the normalized URL or the problem.
 */
export function checkEndpointUrl(
  raw: string,
  allowedHosts: readonly string[],
): { url: string } | { problem: EndpointUrlProblem } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { problem: 'INVALID_URL' };
  }
  if (url.username !== '' || url.password !== '' || url.hash !== '' || raw.length > 500) {
    return { problem: 'INVALID_URL' };
  }
  if (url.protocol !== 'https:') return { problem: 'NOT_HTTPS' };
  if (url.port !== '' && url.port !== '443') return { problem: 'NOT_PORT_443' };
  const host = url.hostname.toLowerCase();
  if (host.startsWith('[') || isIP(host) !== 0 || /^[0-9.]+$/.test(host)) {
    return { problem: 'IP_HOST' };
  }
  if (!allowedHosts.includes(host)) return { problem: 'HOST_NOT_ALLOWED' };
  return { url: url.href };
}

type Resolve = (host: string) => Promise<{ address: string; family: number }[]>;

const systemResolve: Resolve = (host) =>
  new Promise((resolve, reject) => {
    dnsLookup(host, { all: true }, (error, addresses) =>
      error ? reject(error) : resolve(addresses),
    );
  });

/**
 * A lookup for the HTTPS connection: resolves the host once, refuses it when any address is not
 * public, and hands the connection exactly the address checked (so a second resolution cannot
 * swap it). The certificate is still verified against the host name (SNI).
 */
export function guardedLookup(resolve: Resolve = systemResolve): LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname).then(
      (addresses) => {
        const chosen = addresses[0];
        if (!chosen || addresses.some((a) => !isPublicAddress(a.address))) {
          const error: NodeJS.ErrnoException = new Error('ADDRESS_NOT_ALLOWED');
          error.code = 'ADDRESS_NOT_ALLOWED';
          callback(error, '', 4);
          return;
        }
        if (options.all) callback(null, [{ address: chosen.address, family: chosen.family }]);
        else callback(null, chosen.address, chosen.family);
      },
      (error: NodeJS.ErrnoException) => callback(error, '', 4),
    );
  };
}

/** The HTTPS POST: no redirect is followed, at most 2 KB of the answer is kept, 10 s in all. */
export function httpsTransport(resolve?: Resolve): NoticeTransport {
  const lookup = guardedLookup(resolve);
  return {
    send(url, headers, body) {
      return new Promise((done) => {
        let settled = false;
        const finish = (result: DeliveryResult) => {
          if (settled) return;
          settled = true;
          done(result);
        };
        const req = request(
          url,
          {
            method: 'POST',
            headers: { ...headers, 'Content-Length': String(body.length) },
            lookup,
            signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
          },
          (res) => {
            const chunks: Buffer[] = [];
            let kept = 0;
            res.on('data', (chunk: Buffer) => {
              if (kept >= MAX_ANSWER_BYTES) return;
              chunks.push(chunk.subarray(0, MAX_ANSWER_BYTES - kept));
              kept += Math.min(chunk.length, MAX_ANSWER_BYTES - kept);
            });
            const answer = () => Buffer.concat(chunks).toString('utf8');
            res.on('end', () =>
              finish({ status: res.statusCode ?? null, error: null, body: answer() }),
            );
            res.on('error', () => finish({ status: res.statusCode ?? null, error: null }));
          },
        );
        req.on('error', (error: NodeJS.ErrnoException) => {
          const code =
            error.name === 'AbortError' || error.name === 'TimeoutError'
              ? 'TIMEOUT'
              : (error.code ?? error.message);
          finish({ status: null, error: code.slice(0, 300) });
        });
        req.end(body);
      });
    },
  };
}
