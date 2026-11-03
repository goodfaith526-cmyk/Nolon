import {
  CUSTOMER_STAGE_STAFF_STATUSES,
  type CsBookingRequestState,
  type CsShipmentTrackDto,
  type CsStageDto,
} from '@nolon/shared';

/** A customer stage row, as stored. */
export interface StageRow {
  code: string;
  nameAr: string;
  nameEn: string;
  sortOrder: number;
  isActive: boolean;
}

/** A place as the stage reader needs it: a city is itself; a port or site names its city. */
export interface PlaceRow {
  kind: string;
  nameAr: string;
  nameEn: string;
  city: { nameAr: string; nameEn: string } | null;
}

export interface TrackInput {
  state: CsBookingRequestState;
  booking: {
    status: string;
    shipment: {
      number: string;
      status: string;
      destination: PlaceRow;
      currentLocation: PlaceRow | null;
      /** The latest status event's time, or the shipment's creation when it has none. */
      updatedAt: Date;
    } | null;
  } | null;
}

export interface Track {
  stage: CsStageDto | null;
  attention: 'staff' | null;
  shipment: CsShipmentTrackDto | null;
}

/** The first stage: a request still undecided, or a booking still a draft. */
export const BOOKED = 'BOOKED';
/** Stages where the city is the shipment's destination, not where it was last seen. */
const DESTINATION_CITY_STAGES = new Set(['ON_ROAD', 'AT_DESTINATION_HUB', 'DELIVERED']);
/** Always staff, whatever the mapping says (Codex F164-1). */
const STAFF_STATUSES: ReadonlySet<string> = new Set(CUSTOMER_STAGE_STAFF_STATUSES);

function stageDto(row: StageRow | undefined): CsStageDto | null {
  return row && row.isActive
    ? { code: row.code, ar: row.nameAr, en: row.nameEn, order: row.sortOrder }
    : null;
}

function cityOf(place: PlaceRow | null): { ar: string; en: string } | null {
  if (!place) return null;
  if (place.kind === 'CITY') return { ar: place.nameAr, en: place.nameEn };
  return place.city ? { ar: place.city.nameAr, en: place.city.nameEn } : null;
}

/**
 * Plan 09 section 3: the customer's stage from the request's real state (F161-2). An undecided
 * request, or an approved one whose booking is still a draft, is BOOKED; a confirmed booking shows
 * its shipment's mapped stage. A cancelled booking or shipment, or a status with no active stage
 * (on hold, partly delivered), sends the customer to staff. Rejected, cancelled and expired
 * requests have no stage. `sortOrder` orders stages for display only.
 */
export function trackOf(
  input: TrackInput,
  stages: ReadonlyMap<string, StageRow>,
  mapping: ReadonlyMap<string, string>,
): Track {
  const none: Track = { stage: null, attention: null, shipment: null };
  const staff: Track = { stage: null, attention: 'staff', shipment: null };
  if (input.state === 'pending' || input.state === 'awaiting_routing') {
    return { ...none, stage: stageDto(stages.get(BOOKED)) };
  }
  if (input.state !== 'approved' || input.booking === null) return none;
  const { booking } = input;
  if (booking.status === 'CANCELLED') return staff;
  const shipment = booking.shipment;
  if (booking.status === 'DRAFT' || shipment === null) {
    return { ...none, stage: stageDto(stages.get(BOOKED)) };
  }
  const code = STAFF_STATUSES.has(shipment.status) ? undefined : mapping.get(shipment.status);
  const stage = code === undefined ? null : stageDto(stages.get(code));
  const track: CsShipmentTrackDto = {
    number: shipment.number,
    stage,
    city:
      stage === null
        ? null
        : DESTINATION_CITY_STAGES.has(stage.code)
          ? cityOf(shipment.destination)
          : cityOf(shipment.currentLocation),
    updatedAt: shipment.updatedAt.toISOString(),
  };
  return stage === null
    ? { stage: null, attention: 'staff', shipment: track }
    : { stage, attention: null, shipment: track };
}
