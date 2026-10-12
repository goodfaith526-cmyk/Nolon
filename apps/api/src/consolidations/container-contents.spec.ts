import { describe, expect, it } from 'vitest';
import { dec } from '../common/money.js';
import { type ContentShipment, containerContents } from './container-contents.js';

const shipment = (
  id: string,
  customerId: string,
  items: ContentShipment['items'],
): ContentShipment => ({
  id,
  number: `NOL-SHP-${id}`,
  customerId,
  customerName: `Customer ${customerId}`,
  status: 'CONSOLIDATED',
  items,
});

describe('containerContents', () => {
  it('adds up each shipment and the container, counting customers once', () => {
    const visible = new Map([
      ['a', shipment('a', 'c1', [{ quantity: 2, weightKg: dec('500.5'), volumeCbm: dec('2') }])],
      [
        'b',
        shipment('b', 'c1', [
          { quantity: 3, weightKg: dec('100'), volumeCbm: dec('1.25') },
          { quantity: 1, weightKg: dec('0.0001'), volumeCbm: dec('0.75') },
        ]),
      ],
      ['c', shipment('c', 'c2', [{ quantity: 4, weightKg: null, volumeCbm: dec('5') }])],
    ]);
    const r = containerContents(['b', 'a', 'c'], visible);
    expect(r.contents.map((x) => x.shipmentId)).toEqual(['b', 'a', 'c']);
    expect(r.contents[0]).toMatchObject({ packages: 4, weightKg: '100.0001', volumeCbm: '2' });
    expect(r.contents[2]).toMatchObject({ weightKg: null, volumeCbm: '5' });
    expect(r.shipments).toBe(3);
    expect([...r.customerIds]).toEqual(['c1', 'c2']);
    expect(r.packages).toBe(10);
    expect(r.weightKg.toFixed()).toBe('600.5001');
    expect(r.volumeCbm.toFixed()).toBe('9');
  });

  it('leaves out shipments the user may not see', () => {
    const visible = new Map([
      ['a', shipment('a', 'c1', [{ quantity: 1, weightKg: dec('10'), volumeCbm: null }])],
    ]);
    const r = containerContents(['hidden', 'a'], visible);
    expect(r.contents.map((x) => x.shipmentId)).toEqual(['a']);
    expect(r.shipments).toBe(1);
    expect(r.volumeCbm.toFixed()).toBe('0');
    expect(r.contents[0]?.volumeCbm).toBeNull();
  });

  it('is empty for an empty container', () => {
    const r = containerContents([], new Map());
    expect(r).toMatchObject({ contents: [], shipments: 0, packages: 0 });
    expect(r.customerIds.size).toBe(0);
    expect(r.weightKg.toFixed()).toBe('0');
  });
});
