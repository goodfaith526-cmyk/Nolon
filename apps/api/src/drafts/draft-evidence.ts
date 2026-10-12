import { BadRequestException } from '@nestjs/common';
import type { DraftEvidence } from '@nolon/shared';
import { z } from 'zod';
import type { Prisma } from '../generated/prisma/client.js';

// The staff member's own words for the values of a draft decided on the review screen only (a new
// customer, a party, a shipment status change). The assistant checks that the words are the
// user's; it cannot check what they mean, so the screen shows each value next to its words and an
// approval names every value the person ticked (the review screen's counterpart of the assistant's
// chat card). The words are part of the draft: stored with it, in its request hash, and kept
// unchanged once decided like the rest of the row.

const field = z.string().regex(/^[A-Za-z]{1,40}$/, 'Invalid field');

/** The words a kind's draft may carry: one per field, for the fields `allowed` names. */
export function draftEvidence(allowed: readonly string[]) {
  return z
    .array(z.object({ field, quote: z.string().trim().min(1).max(200) }).strict())
    .max(allowed.length)
    .refine((list) => list.every((e) => allowed.includes(e.field)), 'Words for an unknown field')
    .refine((list) => new Set(list.map((e) => e.field)).size === list.length, 'Repeated field')
    .default([]);
}

/** The fields an approval ticked. */
export const confirmedFields = z.array(field).max(30).default([]);

/** The stored words of a draft (a JSON array written by the create). */
export function evidenceOf(stored: Prisma.JsonValue): DraftEvidence[] {
  const parsed = z.array(z.object({ field: z.string(), quote: z.string() })).safeParse(stored);
  return parsed.success ? parsed.data : [];
}

/** The words' part of a request hash: none when there are none, as drafts made before them. */
export function evidenceHashPart(evidence: readonly DraftEvidence[]): object {
  return evidence.length === 0 ? {} : { evidence: evidence.map((e) => [e.field, e.quote]) };
}

/** An approval must name exactly the fields that carry words: each ticked by the person. */
export function requireConfirmed(evidence: readonly DraftEvidence[], confirmed: readonly string[]) {
  const words = new Set(evidence.map((e) => e.field));
  const ticked = new Set(confirmed);
  if (words.size !== ticked.size || [...words].some((f) => !ticked.has(f))) {
    throw new BadRequestException(
      "Tick each value against the staff member's words before approving",
    );
  }
}
