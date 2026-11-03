import { z } from 'zod';

export const IDENTITY_VERSION = 'nolon.customer-identity/1' as const;
export const identityKey = z.string().regex(/^[A-Za-z0-9_-]{8,100}$/);
const text = (max: number) => z.string().trim().min(1).max(max);
export const identityPhone = z.string().regex(/^\+[1-9]\d{5,14}$/);
export const channelContext = z
  .object({
    channel: z.enum(['WHATSAPP', 'TELEGRAM']),
    subjectId: text(32),
    channelAccountId: text(128),
    eventId: text(128),
    observedAt: z.iso.datetime({ offset: true }),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (
      !(v.channel === 'WHATSAPP' ? identityPhone : z.string().regex(/^[1-9]\d{0,31}$/)).safeParse(
        v.subjectId,
      ).success
    ) {
      ctx.addIssue({ code: 'custom', path: ['subjectId'], message: 'Invalid channel identity' });
    }
  });
const phoneEvidence = z
  .object({
    value: identityPhone,
    kind: z.enum(['WHATSAPP_SENDER', 'TELEGRAM_OWN_CONTACT']),
    contactUserId: text(32).optional(),
  })
  .strict();
export const identitySender = channelContext
  .safeExtend({
    username: text(64).optional(),
    displayName: text(200).optional(),
    phoneEvidence: phoneEvidence.optional(),
  })
  .superRefine((s, ctx) => {
    const p = s.phoneEvidence;
    if (
      p &&
      !(s.channel === 'WHATSAPP'
        ? p.kind === 'WHATSAPP_SENDER' && p.value === s.subjectId
        : p.kind === 'TELEGRAM_OWN_CONTACT' && p.contactUserId === s.subjectId)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['phoneEvidence'],
        message: 'Evidence must belong to sender',
      });
    }
  });
const stated = <T extends z.ZodType>(value: T) =>
  z
    .object({
      value: value.nullable(),
      source: z.literal('CUSTOMER_STATEMENT'),
      messageId: text(128).optional(),
    })
    .strict();
export const identityFields = z
  .object({
    name: stated(text(200)).optional(),
    phone: stated(identityPhone).optional(),
    residenceCityId: stated(z.uuid()).optional(),
    address: stated(text(1000)).optional(),
  })
  .strict();
export const captureIdentityBody = z
  .object({
    schemaVersion: z.literal(IDENTITY_VERSION),
    conversationId: text(128),
    sender: identitySender,
    fields: identityFields,
  })
  .strict();
export const updateIdentityBody = captureIdentityBody.extend({
  expectedVersion: z.number().int().min(1),
});
export const followUpIdentityBody = captureIdentityBody
  .omit({ fields: true })
  .extend({
    fields: z.object({}).strict().optional(),
    expectedVersion: z.number().int().min(1),
    residenceCityId: z.uuid(),
    serviceCode: text(40).optional(),
    intent: z.enum(['INITIAL_ASSIGNMENT', 'PERMANENT_MOVE']),
    permanentConfirmed: z.boolean().optional(),
    messageId: text(128).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.intent === 'PERMANENT_MOVE' && (v.permanentConfirmed !== true || !v.messageId)) {
      ctx.addIssue({
        code: 'custom',
        path: ['permanentConfirmed'],
        message: 'Explicit move confirmation required',
      });
    }
  });
export type IdentityContext = z.infer<typeof channelContext>;
export type IdentitySender = z.infer<typeof identitySender>;
export type IdentityCapture = z.infer<typeof captureIdentityBody>;
export type IdentityUpdate = z.infer<typeof updateIdentityBody>;
export type IdentityFollowUp = z.infer<typeof followUpIdentityBody>;
export type IdentityFields = z.infer<typeof identityFields>;
export interface IdentityResult {
  schemaVersion: typeof IDENTITY_VERSION;
  operationId: string;
  outcome: 'CREATED' | 'RESTORED' | 'UPDATED' | 'NEEDS_REVIEW' | 'REJECTED';
  profileId: string | null;
  profileVersion: number | null;
  missing: string[];
  followUp: {
    status: 'UNASSIGNED' | 'ASSIGNED' | 'NEEDS_REVIEW';
    branchId: string | null;
    reason: string | null;
  };
}

export const selfIdentityQuery = z.object({ conversationId: text(128) }).strict();
export const PROFILE_FIELDS = ['name', 'phone', 'residenceCityId', 'address'] as const;
export type ProfileField = (typeof PROFILE_FIELDS)[number];
export interface SelfProfileField {
  value: string | null;
  source: 'CUSTOMER_STATEMENT' | 'WHATSAPP_SENDER' | 'TELEGRAM_OWN_CONTACT' | 'UNRECORDED' | null;
  verification: 'MISSING' | 'UNKNOWN' | 'UNVERIFIED' | 'CHANNEL_VERIFIED';
  observedAt: string | null;
}
export interface SelfProfileResult {
  schemaVersion: typeof IDENTITY_VERSION;
  profileId: string;
  profileVersion: number;
  fields: Record<ProfileField, SelfProfileField>;
  missing: ProfileField[];
  needsReview: boolean;
  followUp: IdentityResult['followUp'];
}
