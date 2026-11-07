import { createHash } from 'node:crypto';
import type {
  CsApprovalPriceDto,
  CsApproveRequest,
  CsBookingRequestStaffDto,
  CsPriceInputs,
  DecimalString,
} from '@nolon/shared';
import type { AppEnv } from '../config/env.js';

/**
 * Owner, 2026-11-07: the staging test autocycle. Pure rules here; the steps in
 * test-autocycle.service.ts.
 */

/** The word a test request's sender name holds. */
export const TEST_MARK = 'اختبار';

/** The system users the autocycle acts as (never signed in: their password hash is unusable). */
export const AUTOCYCLE_STAFF = {
  email: 'test-autocycle@nolon.invalid',
  fullName: 'Test Autocycle',
} as const;
export const AUTOCYCLE_WINDOW = {
  email: 'test-autocycle-window@nolon.invalid',
  fullName: 'Test Autocycle (window)',
} as const;
/** Not of the form scrypt$..., so verifyPassword refuses every password for it. */
export const NO_LOGIN_HASH = '!test-autocycle-no-login';

/** Only requests made within this window are touched: an old test request is left alone. */
export const AUTOCYCLE_LOOKBACK_MS = 24 * 60 * 60 * 1000;
/** A step that failed is tried again after this long (its error is logged once per try). */
export const AUTOCYCLE_RETRY_MS = 5 * 60 * 1000;

/**
 * On only when switched on and not a production deployment. Both staging and production run
 * NODE_ENV=production, so production also needs DEPLOY_STACK=staging, which only the staging
 * compose file sets; the production compose file does not pass the switch at all.
 */
export function autocycleAllowed(
  env: Pick<AppEnv, 'CS_TEST_AUTOCYCLE_ENABLED' | 'NODE_ENV' | 'DEPLOY_STACK'>,
): boolean {
  if (!env.CS_TEST_AUTOCYCLE_ENABLED) return false;
  if (env.DEPLOY_STACK === 'production') return false;
  return env.NODE_ENV !== 'production' || env.DEPLOY_STACK === 'staging';
}

/** Alef with hamza or madda read as bare alef, so «إختبار» counts too. */
function plainAlef(text: string): string {
  return text.replace(/[أإآ]/g, 'ا');
}

/** The request's sender (the other person the bot named, else the chat owner) is a test name. */
export function isTestRequest(r: { senderName: string; otherSenderName: string | null }): boolean {
  return plainAlef(r.otherSenderName ?? r.senderName).includes(TEST_MARK);
}

/** The window's receipt: as many packages as the request has items (one for the one-item shape). */
export function packagesOf(itemCount: number): number {
  return Math.max(1, itemCount);
}

/**
 * The window payment's request id, the same for every try of one request: a retry after a lost
 * answer is the same payment (WindowCollectService answers it as a retry), never a second one.
 */
export function paymentRequestId(requestId: string): string {
  const hex = createHash('sha256').update(`test-autocycle-payment:${requestId}`).digest('hex');
  // A version 4, variant 1 UUID made of the hash.
  const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export interface ApprovalPlan {
  inputs: Omit<CsPriceInputs, 'category' | 'quantity'>;
  lines: { category: string; quantity: DecimalString }[];
  byItems: boolean;
  newCustomer: boolean;
  customerId: string | null;
  dropOffId: string | null;
}

/**
 * What the approval form (apps/web BotRequestApprove) starts from for `r`, the way it opens: the
 * route the bot sent, the mode and currency its quote priced (else the branch's currency), one
 * line per item, the customer the form picks by default. A string: why the request is left for
 * staff (no route, an item outside the categories, a profile to review, no certain line).
 */
export function approvalPlan(
  r: CsBookingRequestStaffDto,
  branchCurrency: string | null,
): ApprovalPlan | string {
  if (r.items.some((i) => i.isOther)) return 'an item outside the standard categories';
  const inputs = {
    originId: r.originId ?? '',
    destinationId: r.destinationId ?? '',
    mode: r.priceCheck?.mode ?? 'SEA',
    currency: r.priceCheck?.currency ?? r.botQuotedPrice?.currency ?? branchCurrency ?? '',
  } satisfies ApprovalPlan['inputs'];
  if (inputs.originId === '' || inputs.destinationId === '' || inputs.currency === '')
    return 'no route or currency';
  const byItems = r.items.length > 0;
  const lines = byItems
    ? r.items.map((i) => ({ category: i.category ?? '', quantity: i.quantity ?? '' }))
    : [{ category: r.category ?? '', quantity: r.quantity }];
  if (lines.some((l) => l.category === '' || l.quantity === '')) return 'a line with no category';
  if (!r.otherSender && r.profile?.needsReview) return 'the customer profile awaits review';
  const registered =
    !r.profile && !r.customerId && !r.otherSender ? (r.instantAccount?.customerId ?? null) : null;
  const newCustomer = !r.profile && !r.customerId && !r.otherSender && registered === null;
  if (r.profile && !r.profile.name && !r.customerId && !r.otherSender)
    return 'the customer profile has no name';
  // The point the customer brings the goods to: the request's own, else the branch's only one
  // (left to the API), else its first window run by an outlet (the cycle goes on at a window).
  const choices = r.dropOffChoices.filter((d) => d.branchId === r.branchId);
  const dropOffId =
    r.dropOffId ??
    (choices.length > 1 ? (choices.find((d) => d.outletName !== null)?.id ?? null) : null);
  return {
    inputs,
    lines,
    byItems,
    newCustomer,
    customerId: r.customerId ?? null,
    dropOffId,
  };
}

/** The approval body the form sends for `plan`, with the prices the API gave for its lines. */
export function approvalBody(
  r: CsBookingRequestStaffDto,
  plan: ApprovalPlan,
  prices: readonly CsApprovalPriceDto[],
): CsApproveRequest {
  const first = plan.lines[0]!;
  return {
    version: r.version,
    ...(r.profile ? { profileVersion: r.profile.version } : {}),
    paymentCurrency: plan.inputs.currency,
    ...(plan.newCustomer ? { newCustomerFromRequest: true as const } : {}),
    ...(plan.dropOffId ? { dropOffId: plan.dropOffId } : {}),
    ...(plan.byItems
      ? {
          pricing: plan.inputs,
          lines: plan.lines.map((l, i) => ({
            ...l,
            pricingFingerprint: prices[i]?.pricingFingerprint ?? null,
          })),
        }
      : {
          pricing: { ...plan.inputs, ...first },
          pricingFingerprint: prices[0]?.pricingFingerprint ?? null,
        }),
    booking: {
      ...(plan.customerId ? { customerId: plan.customerId } : {}),
      services: [...r.services],
      requestedDeparture: r.requestedDate,
    },
  };
}
