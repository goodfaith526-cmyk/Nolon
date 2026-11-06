import { HttpException, HttpStatus } from '@nestjs/common';
import type { CsBookingRequestCreate, CsSenderChannel } from '@nolon/shared';
import type { CsBookingRequest, Prisma } from '../generated/prisma/client.js';
import type { BookingRequestCaller } from './booking-request.guard.js';

/** Who owns a booking request, and which keys still serve it (shared by requests and documents). */

/** Whether a key with these branches serves a request: its branch, or one it may be routed to. */
export function servedBy(
  r: Pick<CsBookingRequest, 'branchId' | 'allowedBranchIds'>,
  branchIds: readonly string[],
): boolean {
  return r.branchId === null
    ? r.allowedBranchIds.some((b) => branchIds.includes(b))
    : branchIds.includes(r.branchId);
}

/** The owner of a request: the customer and the reason of its match, or a channel identity. */
export function ownerRef(caller: BookingRequestCaller, sender?: CsBookingRequestCreate['sender']) {
  return caller.kind === 'customer'
    ? `c:${caller.token.customerId}:${caller.token.grantId}`
    : `s:${sender?.channel ?? ''}:${sender?.id ?? ''}`;
}

/** The proven owner's requests (any id): a customer token, or a signed identity of the sender;
 * the key alone is no proof: 403 OWNER_PROOF_REQUIRED. */
export function provenOwnerOf(
  caller: BookingRequestCaller,
  proof: { channel: CsSenderChannel; subjectId: string } | null,
  what: string,
): Prisma.CsBookingRequestWhereInput {
  if (caller.kind === 'customer')
    return { apiClientId: caller.client.id, ownerRef: ownerRef(caller) };
  if (proof)
    return {
      apiClientId: caller.client.id,
      senderChannel: proof.channel,
      senderId: proof.subjectId,
    };
  throw coded(
    HttpStatus.FORBIDDEN,
    'OWNER_PROOF_REQUIRED',
    `${what} needs the customer token or a signed channel identity of the sender`,
  );
}

function coded(status: HttpStatus, code: string, message: string): HttpException {
  return new HttpException({ message, code, statusCode: status }, status);
}
