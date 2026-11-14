import type { ConsolidationStatus, PalletDto, PalletStatus, TripStatus } from '@nolon/shared';

/**
 * Plan 15-3 (docs/plans/15-customer-notices-every-stage.md, section 3): the pallet's rules, pure
 * functions only. PalletsService applies them under the pallet's row lock.
 */

/** A container carries a pallet until it is unpacked or cancelled. */
export const CARRYING_CONTAINER: readonly ConsolidationStatus[] = [
  'OPEN',
  'CLOSED',
  'LOADED',
  'DEPARTED',
  'ARRIVED',
];

/** A trip carries a pallet while it is planned or under way. */
export const CARRYING_TRIP: readonly TripStatus[] = ['PLANNED', 'DEPARTED'];

export type CarrierState =
  { kind: 'CONTAINER'; status: ConsolidationStatus } | { kind: 'TRIP'; status: TripStatus };

/** Whether the pallet's recorded container or trip still carries it. */
export function carries(carrier: CarrierState | null): boolean {
  if (!carrier) return false;
  return carrier.kind === 'CONTAINER'
    ? CARRYING_CONTAINER.includes(carrier.status)
    : CARRYING_TRIP.includes(carrier.status);
}

/** Whether the carrier lets a whole pallet out now: an open container or a planned trip. */
export function canLeave(carrier: CarrierState): boolean {
  return carrier.kind === 'CONTAINER' ? carrier.status === 'OPEN' : carrier.status === 'PLANNED';
}

/** JED-P0001: the branch code, P and a serial (a fifth digit after 9999). */
export function palletNumber(branchCode: string, value: bigint): string {
  return `${branchCode}-P${value.toString().padStart(4, '0')}`;
}

/** A live pallet holds its shipments: open (filling) or closed (wrapped). */
export function isLive(status: PalletStatus): boolean {
  return status === 'OPEN' || status === 'CLOSED';
}

export interface ActionInput {
  status: PalletStatus;
  shipmentCount: number;
  carrier: CarrierState | null;
  /** Ever carried: cancelling it would hide what happened. */
  used: boolean;
  can: { update: boolean; cancel: boolean; container: boolean; trip: boolean };
}

/** What the user may do with the pallet now (the screen shows only these buttons). */
export function palletActions(input: ActionInput): PalletDto['actions'] {
  const { status, can } = input;
  const carried = carries(input.carrier);
  const closedFree = status === 'CLOSED' && !carried;
  return {
    addShipments: can.update && status === 'OPEN',
    close: can.update && status === 'OPEN' && input.shipmentCount > 0,
    putInContainer: can.update && can.container && closedFree,
    putOnTrip: can.update && can.trip && closedFree,
    takeOut:
      can.update &&
      status === 'CLOSED' &&
      input.carrier !== null &&
      carried &&
      canLeave(input.carrier) &&
      (input.carrier.kind === 'CONTAINER' ? can.container : can.trip),
    unpack: can.update && status === 'CLOSED' && !carried,
    cancel: can.cancel && isLive(status) && !input.used && !carried,
  };
}
