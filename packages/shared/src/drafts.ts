import type { FormRefusal } from './commercial.js';
import type { DraftPriceSource } from './commercial-drafts.js';
import type { DecimalString } from './currencies.js';

/**
 * Entry drafts proposed by the staff AI assistant (erp-agents docs/packing-list-grn-drafts.md,
 * the first type). The assistant proposes; a person reviews, edits, approves or rejects; an
 * approval records the real entry through NOLON's own service with that person's permissions and
 * branch. The assistant never approves, edits or posts. Every entry type has its own tables (real
 * Decimal columns and database checks) and shares the rules below.
 */

/** An undecided draft past its expiry reads as EXPIRED; nothing can change it. */
export const DRAFT_STATUSES = ['DRAFT', 'APPROVED', 'REJECTED', 'EXPIRED'] as const;
export type DraftStatus = (typeof DRAFT_STATUSES)[number];

/** Days a draft stays open for review (owner decision, 2026-10-10). */
export const DRAFT_TTL_DAYS = 7;

/**
 * Days after a draft's expiry during which the record of what the assistant proposed cannot be
 * removed (data governance v2.1, section 4: 90 days from expiry or rejection, to be confirmed).
 * A draft is decided before it expires, so this is never less than 90 days after a decision.
 */
export const DRAFT_PROPOSAL_RETENTION_DAYS = 90;

/**
 * Days an undecided draft is kept after its expiry, and a rejected draft after its rejection,
 * before the retention purge removes it with its lines (data governance v2.1, section 4). An
 * approved draft is kept: it is the record behind the entry it created.
 */
export const DRAFT_RETENTION_DAYS = 90;

/** Who filled a value: the assistant, or a person on the review screen. */
export const DRAFT_FIELD_SOURCES = ['AI', 'STAFF'] as const;
export type DraftFieldSource = (typeof DRAFT_FIELD_SOURCES)[number];

/**
 * What code could check about an AI-filled value against a source document. MATCHED means only
 * that the value was found in the source at the stated position, not that its meaning is right.
 * Drafts with no source document carry null.
 */
export const DRAFT_FIELD_MATCHES = ['MATCHED', 'UNVERIFIED', 'MISMATCH'] as const;
export type DraftFieldMatch = (typeof DRAFT_FIELD_MATCHES)[number];

export interface DraftFieldMeta {
  filledBy: DraftFieldSource;
  /** Null for a value a person typed, or a draft with no source document. */
  match: DraftFieldMatch | null;
}

/** Idempotency keys the assistant sends: scoped to the assistant client and the user. */
export const DRAFT_IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,100}$/;

export interface DraftActions {
  canEdit: boolean;
  canDecide: boolean;
}

export interface DraftRejectRequest {
  version: number;
  reason: string;
}

/** What the assistant gets back: ids, status and counts, never the values it sent. */
export interface EntryDraftSummaryDto {
  id: string;
  status: DraftStatus;
  version: number;
  lineCount: number;
  expiresAt: string;
  createdAt: string;
  /**
   * For kinds saved with missing values (trip, rate card, quotation, booking): the values the
   * draft still misses before it can be approved (MissingFieldsReview), so the assistant can say
   * so. Paths only, never values.
   */
  missingFields?: string[];
}

/**
 * A record's request as an entry draft holds it (owner decision, 2026-10-17): a draft is saved
 * with only its key fields, so each value the record requires (`K`) may be missing (null) until a
 * person fills it in on the review screen. Every value present is checked as the record checks it.
 */
export type DraftValues<T, K extends keyof T> = Omit<T, K> & { [P in K]?: T[P] | null };

/**
 * The branch of a draft whose customer or shipment may be missing: the draft belongs to its
 * customer's or shipment's branch; with neither, it names one of the user's branches (400
 * BRANCH_REQUIRED otherwise, 403 outside them). A branch given with them must be theirs (400
 * BRANCH_MISMATCH). The branch is security context, never a business field.
 */
export interface DraftBranchChoice {
  branchId?: string | null;
}

/**
 * PATCH /<kind>-drafts/:id: a person fills in or changes values of an open draft, at the version
 * they read. Each value given replaces the draft's (null clears it; a list as a whole); the
 * branch stays. The words of a value the person changes are dropped: it is theirs now.
 */
export type DraftUpdateRequest<T> = Partial<T> & { version: number };

/**
 * The values a draft still misses before it can be approved, as request paths (`originLocationId`,
 * `lines[0].quantity`), worked out from the record's own required rules. Empty when complete.
 */
export interface MissingFieldsReview {
  missingFields: string[];
}

/**
 * The code of an approval refused (422) while the draft misses values, or holds values the record
 * would refuse. Every kind's approval runs its completeness and validity gate first, before
 * anything is checked against live data or recorded.
 */
export const DRAFT_INCOMPLETE = 'DRAFT_INCOMPLETE';

/** 422 body of an approval refused by the gate; nothing was recorded. */
export interface DraftIncompleteRefusal {
  statusCode: 422;
  code: typeof DRAFT_INCOMPLETE;
  message: string;
  missingFields: string[];
  /** Values the draft holds that the record would refuse as malformed (usually none). */
  invalidFields: string[];
  /** Both lists' paths, where the web reads a refusal's fields. */
  fields: string[];
}

/**
 * The staff member's own words for one value of a draft (`field`: its path in the request, such
 * as `status` or `shipmentId`), as the assistant checked them against the conversation. Drafts
 * decided on the review screen only carry them, and the person ticks each value against its
 * words before approving.
 */
export interface DraftEvidence {
  field: string;
  quote: string;
}

/** The words of a review-screen draft, and what an approval sends back: each field it ticked. */
export interface EvidenceReviewFields {
  evidence: DraftEvidence[];
}

/** Common to every draft a person reviews. */
export interface EntryDraftReviewFields {
  id: string;
  branchId: string;
  /** What the draft is about, for lists: the customer, the route, the shipment... */
  subject: string;
  status: DraftStatus;
  version: number;
  expiresAt: string;
  createdAt: string;
  /** The staff member the assistant acted for. */
  createdByName: string;
  decidedByName: string | null;
  decidedAt: string | null;
  /** The person decided in the assistant's chat (assistant approval), not on the review screen. */
  decidedFromAssistant: boolean;
  rejectReason: string | null;
  actions: DraftActions;
  /** The draft this one replaced, when the person asked the assistant for changes. */
  replacesDraftId: string | null;
  /** The draft that replaced this one (read on a single draft only). */
  replacedByDraftId?: string | null;
}

/**
 * Whether the draft would be accepted by NOLON now, worked out on every read by the same checks
 * an approval runs (nothing is written). `message` is NOLON's own refusal.
 */
export type EntryDraftCheck =
  | { ok: true; total: DecimalString | null; currency: string | null }
  | { ok: false; message: string };

/** POST .../approve: the version the person reviewed. */
export interface EntryDraftApproveRequest {
  version: number;
}

/**
 * Entry kinds a person may approve or reject from the assistant's chat (erp-agents
 * docs/chat-draft-approval.md), once an admin granted that kind to them. GRN drafts are not among
 * them: their approval needs the receipt details a person enters on the review screen.
 */
export const ASSISTANT_DECIDABLE_KINDS = [
  'quotation',
  'booking',
  'trip',
  'goods_release',
  'invoice',
  'receipt',
] as const;
export type AssistantDecidableKind = (typeof ASSISTANT_DECIDABLE_KINDS)[number];

/** A draft as the assistant's chat card shows it, with what an approval must repeat. */
export interface AssistantDraftDto<D> {
  kind: AssistantDecidableKind;
  /** Fingerprint of the proposed content; an approval sends it back with the version. */
  contentHash: string;
  /** The user holds the grant for this kind (the route's permission is checked on decision). */
  canDecideFromAssistant: boolean;
  draft: D;
  /**
   * A readable name for each id in the draft's proposed values that the user may see. The card
   * shows names, never bare ids; an id missing here sends the person to the review screen.
   */
  names: Record<string, string>;
}

export interface AssistantDraftApproveRequest {
  version: number;
  contentHash: string;
}

/** The kinds a user may decide from the assistant's chat. */
export interface AssistantApprovalGrantsDto {
  userId: string;
  kinds: AssistantDecidableKind[];
}

/**
 * One reason a pre-check refused the values: the field it is about (its path in the request, null
 * when the reason names none), NOLON's code for it (`INVALID` for a malformed value, null when the
 * reason has none), the English message and its params.
 */
export interface DraftCheckRefusal {
  field: string | null;
  code: FormRefusal | 'INVALID' | null;
  message: string;
  params: Record<string, string>;
}

/**
 * A value NOLON fills in when the draft is made (a line's system price), as a pre-check finds it
 * now: `field` is its path in the request (`lines.0.unitPrice`), `value` a decimal string.
 */
export interface DraftComputedValue {
  field: string;
  value: DecimalString;
  source: Exclude<DraftPriceSource['source'], 'TYPED'>;
  rateCardId: string | null;
}

/**
 * POST /<kind>-drafts/check: what a create with these values would get from NOLON now, for this
 * user, without creating anything. `valuesHash` fingerprints the values checked (null when the
 * body is malformed), so the assistant can tie the result to the values it holds; a create runs
 * every check again. A refusal of the route itself (missing permission) stays an HTTP error.
 */
export type DraftPreCheckDto =
  | {
      ok: true;
      valuesHash: string;
      total: DecimalString | null;
      currency: string | null;
      /** The price of each line, for quotation and invoice drafts; null for other kinds. */
      priceSources: DraftPriceSource[] | null;
      /** The values NOLON would fill in (each system-priced line's unit price). */
      computed: DraftComputedValue[];
      /**
       * For kinds saved with missing values: what the draft would still miss (a create saves it,
       * an approval waits for them). Absent for other kinds.
       */
      missingFields?: string[];
    }
  | { ok: false; valuesHash: string | null; refusals: DraftCheckRefusal[] };

/** Draft kinds in the staff member's "my drafts" list (GET /assistant-drafts/mine). */
export const MY_DRAFT_KINDS = [
  'booking',
  'new_customer_booking',
  'quotation',
  'new_customer_quotation',
  'invoice',
  'receipt',
  'trip',
  'goods_release',
  'shipment_status',
  'party',
  'customer',
  'rate_card',
  'grn',
] as const;
export type MyDraftKind = (typeof MY_DRAFT_KINDS)[number];

/** Most drafts one "my drafts" read returns. */
export const MY_DRAFTS_MAX = 50;

/** The kind of record an approval made, and the page that shows it (without the locale). */
export interface MyDraftResult {
  type:
    | 'booking'
    | 'quotation'
    | 'invoice'
    | 'receipt'
    | 'trip'
    | 'warehouse_movement'
    | 'shipment'
    | 'party'
    | 'customer'
    | 'rate_card';
  id: string;
  /** Null for records without a number (a party, a rate card). */
  number: string | null;
  /** Such as `/bookings/<id>`; a release and a party show on their shipment's or customer's page. */
  path: string;
}

/**
 * A draft the assistant made for this user, as "my drafts" lists it: only kinds the user may see
 * now, in branches the user holds now.
 */
export interface MyDraftItemDto {
  kind: MyDraftKind;
  id: string;
  status: DraftStatus;
  /** What the draft is about (the customer, the shipment...), as its review list names it. */
  subject: string;
  branchId: string;
  branchCode: string;
  createdAt: string;
  expiresAt: string;
  decidedAt: string | null;
  decidedByName: string | null;
  rejectReason: string | null;
  /**
   * The draft's review page, without the locale: `/drafts/<page>/<id>`; for a GRN draft, its
   * shipment's page (`/shipments/<id>`).
   */
  reviewPath: string;
  /** Set once approved. */
  result: MyDraftResult | null;
}

/** Draft kinds whose idempotency key the assistant can settle: every kind it creates. */
export const SETTLE_DRAFT_KINDS = MY_DRAFT_KINDS;
export type SettleDraftKind = (typeof SETTLE_DRAFT_KINDS)[number];

/** A settle request (POST /assistant-drafts/settle): the key of a create whose answer was lost. */
export interface DraftKeySettleRequest {
  kind: SettleDraftKind;
  idempotencyKey: string;
}

/**
 * The final answer for a create whose outcome the assistant did not get (a timeout, a lost
 * connection). CREATED: a draft is committed under the key; read it through its kind's by-key
 * route, where a 403 or 404 means only that the user may no longer see it (a permission or branch
 * withdrawn since), never that it was not created. NOT_CREATED: nothing was committed, and from now on nothing will be: a create under this key is
 * refused (409), even one already in flight. Any other answer (401, 403, 5xx) settles nothing.
 */
export type DraftKeySettlementDto =
  { state: 'CREATED'; draftId: string } | { state: 'NOT_CREATED' };

/** One draft kind as NOLON offers it to the assistant (GET /assistant-drafts/capabilities). */
export interface DraftKindCapabilityDto {
  kind: SettleDraftKind;
  /** The kind's routes, without /api/v1 (`:shipmentId` stands for the shipment's id). */
  path: string;
  /** `POST <path>/check` exists: the create's checks, with nothing written. */
  preCheck: boolean;
  /**
   * The review screen's path on the web, without the locale (`:id`: the draft's id). A GRN draft is
   * reviewed with its document on the shipment's page (`:shipmentId`).
   */
  review: string;
  /** This user holds the create's permissions now (NOLON checks them again on create). */
  canCreate: boolean;
  /** Where a person may decide: the review screen only, or also the assistant's chat. */
  approval: 'screen' | 'both';
}

/**
 * What this NOLON offers the assistant, so it can switch off what an older NOLON lacks: a 404 on
 * this route means none of it. Kinds and features are only added; `api` changes only when an
 * existing shape changes.
 */
export interface DraftCapabilitiesDto {
  api: 1;
  features: {
    preCheck: boolean;
    myDrafts: boolean;
    settle: boolean;
    settleAck: boolean;
    /** GET /assistant-drafts/mine takes `ids` (up to MY_DRAFTS_MAX, comma-separated). */
    myDraftsByIds: boolean;
  };
  kinds: DraftKindCapabilityDto[];
}
