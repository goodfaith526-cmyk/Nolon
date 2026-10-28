import { describe, expect, it } from 'vitest';
import { customerShipmentNumber } from './customer-me.service.js';
import { bestGrant, grantId, grantVersion, readCustomerToken } from './customer-tokens.service.js';

const customer = {
  id: '00000000-0000-4000-8000-000000000001',
  number: 'CS00001',
  name: 'A',
  companyName: null,
  phone: '+249911111111',
  whatsapp: '+249922222222',
  updatedAt: new Date('2026-10-01T00:00:00Z'),
  contacts: [{ id: 'k2', phone: '+249933333333', updatedAt: new Date('2026-10-02T00:00:00Z') }],
};

describe('customer tokens', () => {
  it('matches the most direct reason first', () => {
    expect(bestGrant(customer, '+249911111111')).toEqual({
      kind: 'CUSTOMER_PHONE',
      contactId: null,
    });
    expect(bestGrant({ ...customer, whatsapp: customer.phone }, customer.phone)?.kind).toBe(
      'CUSTOMER_PHONE',
    );
    expect(bestGrant(customer, '+249922222222')?.kind).toBe('CUSTOMER_WHATSAPP');
    expect(bestGrant(customer, '+249933333333')).toEqual({
      kind: 'CONTACT_PHONE',
      contactId: 'k2',
    });
    expect(bestGrant(customer, '+249944444444')).toBeNull();
  });

  it('versions a grant by the latest change of the records it rests on', () => {
    const c = new Date('2026-10-01T00:00:00Z');
    const k = new Date('2026-10-02T00:00:00Z');
    expect(grantVersion(c, null)).toBe(c.getTime());
    expect(grantVersion(c, k)).toBe(k.getTime());
    expect(grantVersion(k, c)).toBe(k.getTime());
  });

  it('gives a stable, opaque grant id per reason', () => {
    const phone = grantId(customer.id, { kind: 'CUSTOMER_PHONE', contactId: null });
    expect(phone).toMatch(/^g[0-9a-f]{40}$/);
    expect(grantId(customer.id, { kind: 'CUSTOMER_PHONE', contactId: null })).toBe(phone);
    expect(grantId(customer.id, { kind: 'CUSTOMER_WHATSAPP', contactId: null })).not.toBe(phone);
  });

  it('reads only a well-formed customer token', () => {
    const token = `nolct_${'A'.repeat(43)}`;
    expect(readCustomerToken(`Bearer ${token}`)).toBe(token);
    expect(readCustomerToken(`Bearer nolcs_${'a'.repeat(12)}_${'A'.repeat(43)}`)).toBeNull();
    expect(readCustomerToken(token)).toBeNull();
    expect(readCustomerToken(undefined)).toBeNull();
  });

  it('reads shipment numbers as customers write them', () => {
    expect(customerShipmentNumber(' bk00125 ')).toBe('BK00125');
    expect(customerShipmentNumber('dxb-krt-0001')).toBe('DXB-KRT-0001');
    expect(customerShipmentNumber('NOL-SHP-2026-000125')).toBe('NOL-SHP-2026-000125');
    expect(customerShipmentNumber('shp-2026-000125')).toBe('NOL-SHP-2026-000125');
  });
});
