import { describe, expect, it } from 'vitest';
import { dec } from '../common/money.js';
import {
  type MovementAmounts,
  canRelease,
  defaultReceiptStatus,
  onHandPackages,
  receiptStatusOptions,
  totalsByWarehouse,
} from './warehouse-rules.js';

const receipt = (warehouseId: string, packages: number, weight?: string): MovementAmounts => ({
  kind: 'RECEIPT',
  warehouseId,
  packages,
  weightKg: weight ? dec(weight) : null,
});
const release = (warehouseId: string, packages: number, weight?: string): MovementAmounts => ({
  kind: 'RELEASE',
  warehouseId,
  packages,
  weightKg: weight ? dec(weight) : null,
});

describe('warehouse totals', () => {
  it('on hand is received minus released, per warehouse', () => {
    const movements = [
      receipt('A', 6, '120.5'),
      receipt('A', 4, '80'),
      release('A', 3, '60.25'),
      receipt('B', 2),
    ];
    const totals = totalsByWarehouse(movements);
    expect(totals.get('A')).toMatchObject({
      receivedPackages: 10,
      releasedPackages: 3,
      onHandPackages: 7,
    });
    expect(totals.get('A')?.receivedWeightKg.toFixed()).toBe('200.5');
    expect(totals.get('A')?.releasedWeightKg.toFixed()).toBe('60.25');
    expect(totals.get('B')).toMatchObject({ receivedPackages: 2, onHandPackages: 2 });
    expect(totals.get('B')?.receivedWeightKg.toFixed()).toBe('0');
    expect([...totals.keys()]).toEqual(['A', 'B']);
  });

  it('a warehouse with no movements holds nothing', () => {
    expect(onHandPackages([receipt('A', 5)], 'B')).toBe(0);
  });

  it('goods held in one warehouse cannot be released from another', () => {
    const movements = [receipt('A', 5)];
    expect(canRelease(onHandPackages(movements, 'A'), 5)).toBe(true);
    expect(canRelease(onHandPackages(movements, 'B'), 1)).toBe(false);
  });
});

describe('canRelease: release <= received - released', () => {
  it('allows a partial and then the rest', () => {
    const movements = [receipt('A', 10)];
    expect(canRelease(onHandPackages(movements, 'A'), 4)).toBe(true);
    movements.push(release('A', 4));
    expect(canRelease(onHandPackages(movements, 'A'), 6)).toBe(true);
    movements.push(release('A', 6));
    expect(onHandPackages(movements, 'A')).toBe(0);
  });

  it('refuses more than is on hand, zero, negative and fractional packages', () => {
    const onHand = onHandPackages([receipt('A', 10), release('A', 7)], 'A');
    expect(onHand).toBe(3);
    expect(canRelease(onHand, 4)).toBe(false);
    expect(canRelease(onHand, 0)).toBe(false);
    expect(canRelease(onHand, -1)).toBe(false);
    expect(canRelease(onHand, 1.5)).toBe(false);
    expect(canRelease(0, 1)).toBe(false);
  });
});

describe('receipt statuses', () => {
  it('offers only the warehouse statuses the state machine allows now', () => {
    expect(receiptStatusOptions(['LOADED', 'RECEIVED_ORIGIN_WAREHOUSE'])).toEqual([
      'RECEIVED_ORIGIN_WAREHOUSE',
    ]);
    expect(receiptStatusOptions(['LOADED', 'DEPARTED'])).toEqual([]);
  });

  it('preselects the status only when exactly one is allowed', () => {
    expect(defaultReceiptStatus(['RECEIVED_DESTINATION_WAREHOUSE'])).toBe(
      'RECEIVED_DESTINATION_WAREHOUSE',
    );
    expect(defaultReceiptStatus([])).toBeNull();
    expect(
      defaultReceiptStatus(['RECEIVED_ORIGIN_WAREHOUSE', 'RECEIVED_DESTINATION_WAREHOUSE']),
    ).toBeNull();
  });
});
