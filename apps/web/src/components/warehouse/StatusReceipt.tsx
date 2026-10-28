'use client';

import {
  GOODS_CONDITIONS,
  WAREHOUSE_RECEIPT_STATUSES,
  type GoodsCondition,
  type GoodsReceiptRequest,
  type ShipmentStatus,
  type ShipmentWarehouseDto,
  type WarehouseDto,
  type WarehouseReceiptStatus,
} from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { field } from '@/lib/form';
import { useLocalName } from '@/lib/master-data';

/** A status that says the goods are in a warehouse (a goods receipt status). */
export function isReceiptStatus(status: ShipmentStatus | ''): status is WarehouseReceiptStatus {
  return (WAREHOUSE_RECEIPT_STATUSES as readonly string[]).includes(status);
}

/**
 * What the shipment status form needs to record a goods receipt with a warehouse status: the
 * shipment's warehouse view (what may be received now) and the user's active warehouses. Loaded
 * while `enabled` (the status form is open and the user sees the warehouse).
 */
export function useStatusReceipt(
  shipmentId: string,
  enabled: boolean,
): { view: ShipmentWarehouseDto | null; warehouses: WarehouseDto[] } {
  const [view, setView] = useState<ShipmentWarehouseDto | null>(null);
  const [warehouses, setWarehouses] = useState<WarehouseDto[]>([]);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    Promise.all([
      api<ShipmentWarehouseDto>(`/shipments/${shipmentId}/warehouse`),
      api<WarehouseDto[]>('/warehouses'),
    ])
      .then(([v, list]) => {
        if (cancelled) return;
        setView(v);
        setWarehouses(list.filter((w) => w.isActive));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [shipmentId, enabled]);
  return { view: enabled ? view : null, warehouses };
}

/**
 * Whether moving to `status` records a goods receipt too: the user may receive now, the move is
 * one a receipt makes, packages are still to receive, and there is a warehouse to receive in.
 * Otherwise the status changes alone.
 */
export function receiptRecordsStatus(
  status: ShipmentStatus | '',
  view: ShipmentWarehouseDto | null,
  warehouses: readonly WarehouseDto[],
): boolean {
  return (
    isReceiptStatus(status) &&
    view !== null &&
    view.actions.canReceive &&
    view.actions.receiptStatuses.includes(status) &&
    view.remainingPackages > 0 &&
    warehouses.length > 0
  );
}

/** The goods receipt the status form records, from its fields. */
export function statusReceiptBody(
  form: FormData,
  status: WarehouseReceiptStatus,
  occurredAt: string | undefined,
): GoodsReceiptRequest {
  return {
    warehouseId: field(form, 'warehouseId'),
    packages: Number.parseInt(field(form, 'packages'), 10),
    weightKg: field(form, 'weightKg').trim() || null,
    condition: field(form, 'condition') as GoodsCondition,
    note: field(form, 'note').trim() || null,
    occurredAt,
    shipmentStatus: status,
  };
}

/** Weight inputs: what the API accepts (up to 9 integer and 3 decimal digits). */
const WEIGHT_PATTERN = '\\d{1,9}(\\.\\d{1,3})?';

/**
 * The receipt fields of the status form. The warehouse at the status's usual place is picked
 * first; the packages start at what is still to receive, for the person to count and confirm.
 */
export function StatusReceiptFields({
  view,
  warehouses,
  usualLocationId,
}: {
  view: ShipmentWarehouseDto;
  warehouses: readonly WarehouseDto[];
  usualLocationId: string | undefined;
}) {
  const t = useTranslations('Warehouse');
  const te = useTranslations('Enums');
  const localName = useLocalName();
  const usual = warehouses.find((w) => usualLocationId && w.locationId === usualLocationId);
  return (
    <>
      <div className="grid">
        <label className="field">
          <span>{t('warehouse')}</span>
          <select name="warehouseId" required defaultValue={(usual ?? warehouses[0])?.id}>
            {warehouses.map((w) => (
              <option key={w.id} value={w.id}>
                {w.code} · {localName(w)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{t('packages')}</span>
          <input
            name="packages"
            type="number"
            required
            min={1}
            max={view.remainingPackages}
            step={1}
            defaultValue={view.remainingPackages}
            dir="ltr"
          />
        </label>
        <label className="field">
          <span>{t('weightKg')}</span>
          <input name="weightKg" inputMode="decimal" pattern={WEIGHT_PATTERN} dir="ltr" />
        </label>
        <label className="field">
          <span>{t('condition')}</span>
          <select name="condition" required defaultValue="GOOD">
            {GOODS_CONDITIONS.map((c) => (
              <option key={c} value={c}>
                {te(`condition_${c}`)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="muted">
        {t('statusReceiptHint', {
          remaining: view.remainingPackages,
          packages: view.expectedPackages,
        })}
      </p>
    </>
  );
}
