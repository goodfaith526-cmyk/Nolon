import { describe, expect, it } from 'vitest';
import { outcomeOf, retryDelayMs } from './cs-outbox.worker.js';
import {
  checkEndpointUrl,
  httpsTransport,
  isPublicAddress,
  noticeHeaders,
  signNotice,
} from './webhook-delivery.js';

describe('notice signature (receiver contract of 2026-11-03)', () => {
  it('matches the contract test vector', () => {
    expect(
      signNotice(
        'k'.repeat(32),
        'erp-agents:nolon',
        '6f1c1b1e-0000-4000-8000-000000000001',
        1800000000,
        Buffer.from('{}'),
      ),
    ).toBe('i1juE-jK1W_zqdtAx4e9SGahKeE_i3yVwGG9qAHP-jI');
  });

  it('sends the timestamp, the key id and the signature of the exact body', () => {
    const body = Buffer.from('{"a":1}');
    const headers = noticeHeaders('s'.repeat(32), 'aud', 'key', 1700000000, body);
    expect(headers).toMatchObject({
      'Content-Type': 'application/json',
      'X-Nolon-Timestamp': '1700000000',
      'X-Nolon-Key-Id': 'key',
    });
    expect(headers['X-Nolon-Signature']).toBe(
      signNotice('s'.repeat(32), 'aud', 'key', 1700000000, body),
    );
    expect(headers['X-Nolon-Signature']).not.toMatch(/[=+/]/);
    // Another audience, key, time or body is another signature.
    for (const other of [
      signNotice('s'.repeat(32), 'aud2', 'key', 1700000000, body),
      signNotice('s'.repeat(32), 'aud', 'key2', 1700000000, body),
      signNotice('s'.repeat(32), 'aud', 'key', 1700000001, body),
      signNotice('s'.repeat(32), 'aud', 'key', 1700000000, Buffer.from('{"a":2}')),
    ]) {
      expect(other).not.toBe(headers['X-Nolon-Signature']);
    }
  });
});

describe('endpoint addresses', () => {
  const allowed = ['agent.example.com'];

  it('takes https on port 443 at an allowed host name', () => {
    expect(
      checkEndpointUrl('https://agent.example.com/api/v1/whatsapp/erp-events/nolon', allowed),
    ).toEqual({
      url: 'https://agent.example.com/api/v1/whatsapp/erp-events/nolon',
    });
    expect(checkEndpointUrl('https://AGENT.example.com:443/x', allowed)).toEqual({
      url: 'https://agent.example.com/x',
    });
  });

  it('refuses http, another port, an IP, credentials and a host not allowed', () => {
    expect(checkEndpointUrl('http://agent.example.com/x', allowed)).toEqual({
      problem: 'NOT_HTTPS',
    });
    expect(checkEndpointUrl('https://agent.example.com:8443/x', allowed)).toEqual({
      problem: 'NOT_PORT_443',
    });
    expect(checkEndpointUrl('https://127.0.0.1/x', ['127.0.0.1'])).toEqual({ problem: 'IP_HOST' });
    expect(checkEndpointUrl('https://[::1]/x', allowed)).toEqual({ problem: 'IP_HOST' });
    expect(checkEndpointUrl('https://u:p@agent.example.com/x', allowed)).toEqual({
      problem: 'INVALID_URL',
    });
    expect(checkEndpointUrl('https://other.example.com/x', allowed)).toEqual({
      problem: 'HOST_NOT_ALLOWED',
    });
    expect(checkEndpointUrl('not a url', allowed)).toEqual({ problem: 'INVALID_URL' });
  });

  it('calls public addresses only', () => {
    for (const ip of ['8.8.8.8', '2.28.12.44', '2606:4700::1111'])
      expect(isPublicAddress(ip)).toBe(true);
    for (const ip of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '::1',
      'fe80::1',
      'fd00::1',
      '::ffff:10.0.0.1',
      '::ffff:127.0.0.1',
      '::ffff:a00:1',
      'not-an-ip',
    ]) {
      expect(isPublicAddress(ip)).toBe(false);
    }
  });

  it('never connects when the host resolves to a private or loopback address', async () => {
    for (const address of ['127.0.0.1', '10.0.0.5']) {
      const transport = httpsTransport(() => Promise.resolve([{ address, family: 4 }]));
      const result = await transport.send('https://agent.example.com/x', {}, Buffer.from('{}'));
      expect(result).toEqual({ status: null, error: 'ADDRESS_NOT_ALLOWED' });
    }
    // One private address among public ones is enough to refuse.
    const mixed = httpsTransport(() =>
      Promise.resolve([
        { address: '8.8.8.8', family: 4 },
        { address: '192.168.0.1', family: 4 },
      ]),
    );
    expect(await mixed.send('https://agent.example.com/x', {}, Buffer.from('{}'))).toEqual({
      status: null,
      error: 'ADDRESS_NOT_ALLOWED',
    });
  });
});

describe('what an answer means', () => {
  const created = new Date('2026-11-03T00:00:00Z');
  const at = (minutes: number) => new Date(created.getTime() + minutes * 60_000);

  it('2xx is sent, 400 is given up, everything else is tried again later', () => {
    expect(outcomeOf({ status: 200, error: null }, 1, created, at(0)).status).toBe('SENT');
    expect(outcomeOf({ status: 204, error: null }, 1, created, at(0)).status).toBe('SENT');
    expect(outcomeOf({ status: 400, error: null }, 1, created, at(0)).status).toBe('FAILED');
    for (const status of [302, 401, 404, 500, 503]) {
      const outcome = outcomeOf({ status, error: null }, 1, created, at(0));
      expect(outcome.status).toBe('PENDING');
      expect(outcome.nextAttemptAt).toEqual(at(0.5));
    }
    expect(outcomeOf({ status: null, error: 'TIMEOUT' }, 3, created, at(0))).toEqual({
      status: 'PENDING',
      nextAttemptAt: at(2),
    });
  });

  it('backs off to an hour and gives up a day after the notice was written', () => {
    expect(retryDelayMs(1)).toBe(30_000);
    expect(retryDelayMs(2)).toBe(60_000);
    expect(retryDelayMs(20)).toBe(3_600_000);
    expect(outcomeOf({ status: 503, error: null }, 20, created, at(23 * 60)).status).toBe(
      'PENDING',
    );
    expect(outcomeOf({ status: 503, error: null }, 20, created, at(23 * 60 + 1)).status).toBe(
      'FAILED',
    );
  });
});
