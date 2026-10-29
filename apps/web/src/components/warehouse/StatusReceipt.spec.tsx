import type { ShipmentWarehouseDto, WarehouseDto } from '@nolon/shared';
import { describe, expect, it } from 'vitest';
import { isReceiptStatus, receiptRecordsStatus, statusReceiptBody } from './StatusReceipt';

const view = (
  over: Partial<ShipmentWarehouseDto> = {},
  canReceive = true,
): ShipmentWarehouseDto => ({
  expectedPackages: 10,
  heldPackages: 0,
  remainingPackages: 10,
  balances: [],
  movements: [],
  actions: {
    canReceive,
    canRelease: false,
    canAddPhotos: false,
    canCancelMovements: false,
    receiptStatuses: ['RECEIVED_ORIGIN_WAREHOUSE'],
    defaultReceiptStatus: 'RECEIVED_ORIGIN_WAREHOUSE',
  },
  ...over,
});
const warehouses = [{ id: 'w1', isActive: true } as WarehouseDto];

describe('the status form records a goods receipt for a warehouse status', () => {
  it('knows the warehouse statuses', () => {
    expect(isReceiptStatus('RECEIVED_ORIGIN_WAREHOUSE')).toBe(true);
    expect(isReceiptStatus('RECEIVED_DESTINATION_WAREHOUSE')).toBe(true);
    expect(isReceiptStatus('LOADED')).toBe(false);
    expect(isReceiptStatus('')).toBe(false);
  });

  it('records one when the user may receive, packages remain and a warehouse exists', () => {
    expect(receiptRecordsStatus('RECEIVED_ORIGIN_WAREHOUSE', view(), warehouses)).toBe(true);
  });

  it('changes the status alone otherwise', () => {
    expect(receiptRecordsStatus('LOADED', view(), warehouses)).toBe(false);
    expect(receiptRecordsStatus('RECEIVED_ORIGIN_WAREHOUSE', null, warehouses)).toBe(false);
    expect(receiptRecordsStatus('RECEIVED_ORIGIN_WAREHOUSE', view({}, false), warehouses)).toBe(
      false,
    );
    expect(receiptRecordsStatus('RECEIVED_ORIGIN_WAREHOUSE', view(), [])).toBe(false);
    // Everything already received (a receipt without the status): only the status moves.
    expect(
      receiptRecordsStatus(
        'RECEIVED_ORIGIN_WAREHOUSE',
        view({ heldPackages: 10, remainingPackages: 0 }),
        warehouses,
      ),
    ).toBe(false);
    // A move a receipt does not make now.
    expect(receiptRecordsStatus('RECEIVED_DESTINATION_WAREHOUSE', view(), warehouses)).toBe(false);
  });

  it('sends the receipt with the status it moves the shipment to', () => {
    const form = new FormData();
    form.set('warehouseId', 'w1');
    form.set('packages', '7');
    form.set('weightKg', ' ');
    form.set('condition', 'DAMAGED');
    form.set('note', ' wet cartons ');
    expect(
      statusReceiptBody(form, 'RECEIVED_ORIGIN_WAREHOUSE', '2026-10-28T10:00:00.000Z'),
    ).toEqual({
      warehouseId: 'w1',
      packages: 7,
      weightKg: null,
      condition: 'DAMAGED',
      note: 'wet cartons',
      occurredAt: '2026-10-28T10:00:00.000Z',
      shipmentStatus: 'RECEIVED_ORIGIN_WAREHOUSE',
    });
  });
});
