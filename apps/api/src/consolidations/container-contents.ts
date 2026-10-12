import type { ContainerContentRowDto, DecimalString, ShipmentStatus } from '@nolon/shared';
import { type Decimal, ZERO, toDecimalString } from '../common/money.js';

/** A shipment as the shipments module gives it for a container (ShipmentsService.tripSummaries). */
export interface ContentShipment {
  id: string;
  number: string;
  customerId: string;
  customerName: string;
  status: ShipmentStatus;
  items: { quantity: number; weightKg: Decimal | null; volumeCbm: Decimal | null }[];
}

export interface ContainerContents {
  contents: ContainerContentRowDto[];
  shipments: number;
  /** Distinct customers, by id (two customers may share a name). */
  customerIds: Set<string>;
  packages: number;
  weightKg: Decimal;
  volumeCbm: Decimal;
}

/** The sum of the values given; null when none is. */
function present(values: (Decimal | null)[]): Decimal | null {
  const given = values.filter((v): v is Decimal => v !== null);
  return given.length === 0 ? null : given.reduce((acc, v) => acc.plus(v), ZERO);
}

const text = (value: Decimal | null): DecimalString | null =>
  value === null ? null : toDecimalString(value);

/**
 * What is in a container: its shipments in the order they were put in, those the user may see
 * only (`visible`), each with its cargo lines added up, and the container's totals. A line
 * without a weight or volume adds nothing; a shipment with none of them shows null.
 */
export function containerContents(
  shipmentIds: readonly string[],
  visible: ReadonlyMap<string, ContentShipment>,
): ContainerContents {
  const result: ContainerContents = {
    contents: [],
    shipments: 0,
    customerIds: new Set(),
    packages: 0,
    weightKg: ZERO,
    volumeCbm: ZERO,
  };
  for (const id of shipmentIds) {
    const s = visible.get(id);
    if (!s) continue;
    const packages = s.items.reduce((n, i) => n + i.quantity, 0);
    const weightKg = present(s.items.map((i) => i.weightKg));
    const volumeCbm = present(s.items.map((i) => i.volumeCbm));
    result.contents.push({
      shipmentId: s.id,
      shipmentNumber: s.number,
      customerId: s.customerId,
      customerName: s.customerName,
      status: s.status,
      packages,
      weightKg: text(weightKg),
      volumeCbm: text(volumeCbm),
    });
    result.shipments += 1;
    result.customerIds.add(s.customerId);
    result.packages += packages;
    result.weightKg = result.weightKg.plus(weightKg ?? ZERO);
    result.volumeCbm = result.volumeCbm.plus(volumeCbm ?? ZERO);
  }
  return result;
}
