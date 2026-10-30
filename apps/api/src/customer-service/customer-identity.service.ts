import { lockActiveBranches } from '../common/branch-locks.js';
import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { Prisma, type CustomerProfile } from '../generated/prisma/client.js';
import { nextSequenceValue } from '../common/numbering.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { CustomersService } from '../customers/customers.service.js';
import {
  CustomerIdentityAuth,
  identityError,
  sha256,
  type IdentityEnvelope,
} from './customer-identity-auth.js';
import {
  IDENTITY_VERSION,
  type IdentityCapture,
  type IdentityUpdate,
  type IdentityFollowUp,
  type IdentityResult,
  type IdentityFields,
  PROFILE_FIELDS,
  type SelfProfileField,
  type SelfProfileResult,
} from './customer-identity.contract.js';

type Tx = Prisma.TransactionClient;
type Input = IdentityCapture | IdentityUpdate | IdentityFollowUp;
export interface ProfileBookingBinding {
  profileId: string;
  conversationId: string;
  context: IdentityEnvelope['context'];
}
const DAY = 86_400_000;
const json = (v: unknown) => JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;
export async function identityLock(tx: Tx, key: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`customer-profile:${key}`}, 0))`;
}

/** All identity writes and the saved original response commit together. No external calls/worker gap. */
@Injectable()
export class CustomerIdentityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: CustomerIdentityAuth,
    private readonly customers: CustomersService,
  ) {}

  get companyId(): string {
    return this.auth.companyId;
  }

  requireBookingEnabled(): void {
    this.auth.enabled('booking');
  }

  async requireKey(tx: Tx, clientId: string) {
    this.auth.enabled();
    await tx.$queryRaw`SELECT id FROM api_clients WHERE id = ${clientId}::uuid FOR SHARE`;
    const client = await tx.apiClient.findUnique({
      where: { id: clientId },
      include: { scopes: true, branches: true },
    });
    if (!client?.isActive || !client.scopes.some((s) => s.scope === 'CUSTOMER_PROFILES_WRITE'))
      identityError(403, 'SCOPE_REQUIRED');
    return client;
  }

  async write(
    clientId: string,
    envelope: IdentityEnvelope,
    input: Input,
    requestedProfile?: string,
  ): Promise<{ created: boolean; body: IdentityResult }> {
    if ('intent' in input) this.auth.enabled('followup');
    const companyId = this.auth.companyId;
    const hash = sha256(`${envelope.method}\n${envelope.path}\n${sha256(envelope.rawBody)}`);
    return this.prisma
      .$transaction(async (tx) => {
        const client = await this.requireKey(tx, clientId);
        // Also serializes the per-key daily quota across processes and identities.
        await identityLock(tx, `${companyId}:key:${clientId}`);
        const previous = await tx.customerProfileOperation.findUnique({
          where: {
            companyId_apiClientId_idempotencyKey: {
              companyId,
              apiClientId: clientId,
              idempotencyKey: envelope.idempotencyKey,
            },
          },
          include: { identity: true },
        });
        if (previous) {
          if (!sameSender(previous.identity, envelope)) identityError(404, 'OPERATION_NOT_FOUND');
          if (previous.contentHash !== hash) identityError(409, 'IDEMPOTENCY_CONFLICT');
          requireUnexpired(previous.createdAt);
          return { created: false, body: previous.result as unknown as IdentityResult };
        }
        const { channel, subjectId } = envelope.context;
        await identityLock(tx, `${companyId}:identity:${channel}:${subjectId}`);
        const selector = { companyId, channel, subjectId };
        let identity = await tx.customerChannelIdentity.findUnique({
          where: { companyId_channel_subjectId: selector },
        });
        if (
          requestedProfile &&
          (!identity?.profileId || identity.profileId !== requestedProfile || identity.blocked)
        )
          identityError(404, 'PROFILE_NOT_BOUND');

        const now = new Date();
        const [daily, hourly] = await Promise.all([
          tx.customerProfileOperation.count({
            where: {
              companyId,
              apiClientId: clientId,
              createdAt: { gte: new Date(now.getTime() - DAY) },
            },
          }),
          identity
            ? tx.customerProfileOperation.count({
                where: {
                  companyId,
                  identityId: identity.id,
                  createdAt: { gte: new Date(now.getTime() - 3_600_000) },
                },
              })
            : 0,
        ]);
        if (daily >= 1000 || hourly >= 10)
          identityError(429, 'CAPTURE_LIMIT', { retryAfterSeconds: 3600 });
        const fields: IdentityFields = 'fields' in input ? (input.fields ?? {}) : {};
        const phoneEvidence =
          input.sender.channel === 'WHATSAPP'
            ? { value: input.sender.subjectId, kind: 'WHATSAPP_SENDER' as const }
            : input.sender.phoneEvidence;
        const phone = phoneEvidence?.value ?? fields.phone?.value ?? null;
        // Serialize possible phone claims even across keys/channels; a phone never auto-links people.
        const phones = [
          ...new Set([phone, fields.phone?.value].filter((v): v is string => !!v)),
        ].sort();
        for (const p of phones) await identityLock(tx, `${companyId}:phone:${p}`);
        if (!identity) {
          identity = await tx.customerChannelIdentity.create({
            data: {
              ...selector,
              observedAt: new Date(input.sender.observedAt),
              username: input.sender.username,
              displayName: input.sender.displayName,
            },
          });
        }
        await identityLock(tx, `${companyId}:conversation:${clientId}:${input.conversationId}`);
        const conversationWhere = {
          companyId,
          apiClientId: clientId,
          conversationId: input.conversationId,
        };
        const conversation = await tx.customerProfileConversation.findUnique({
          where: { companyId_apiClientId_conversationId: conversationWhere },
        });
        if (conversation && conversation.identityId !== identity.id)
          identityError(409, 'CONVERSATION_IDENTITY_CONFLICT');
        if (requestedProfile && !conversation) identityError(404, 'PROFILE_NOT_BOUND');
        if (!conversation)
          await tx.customerProfileConversation.create({
            data: { ...conversationWhere, identityId: identity.id },
          });

        let profile = identity.profileId ? await this.lockProfile(tx, identity.profileId) : null;
        if (profile && profile.companyId !== companyId) identityError(404, 'PROFILE_NOT_BOUND');
        if ('expectedVersion' in input && profile?.version !== input.expectedVersion)
          identityError(409, 'VERSION_CONFLICT', { currentVersion: profile?.version ?? null });
        const beforeBranchId = profile?.followUpBranchId ?? null;
        const operationId = randomUUID();
        const candidates = phone ? await this.phoneTaken(tx, companyId, phone, profile?.id) : false;
        let created = false;
        let review = profile?.needsReview ?? false;
        let identityReview = review;
        let changed = false;
        if (!profile && !identity.blocked && !candidates && identity.pending === null) {
          const number = `CP${(await nextSequenceValue(tx, 'CUSTOMER_PROFILE')).toString().padStart(6, '0')}`;
          profile = await tx.customerProfile.create({ data: { companyId, number } });
          identity = await tx.customerChannelIdentity.update({
            where: { id: identity.id },
            data: { profileId: profile.id },
          });
          created = true;
        }
        const evidence: Prisma.CustomerProfileEvidenceCreateManyInput[] = [];
        let reason: string | null = null;
        if (!profile && !identity.blocked) {
          review = true;
          // Kept for a privileged review, never exposes the candidate or treats the match as proof.
          if (identity.pending === null)
            await tx.customerChannelIdentity.update({
              where: { id: identity.id },
              data: {
                pending: json({ fields, phoneEvidence: phoneEvidence ?? null }),
              },
            });
          await tx.customerProfileReview.create({
            data: {
              companyId,
              actor: 'ai_agent',
              entityId: identity.id,
              action: 'PENDING_CAPTURE',
              reason: 'Ownership requires a human review',
              snapshot: json({
                operationId,
                fields,
                phoneEvidence: phoneEvidence ?? null,
              }),
            },
          });
        }
        if (profile && !identity.blocked) {
          const data: Prisma.CustomerProfileUncheckedUpdateInput = {};
          for (const field of ['name', 'phone', 'residenceCityId', 'address'] as const) {
            const stated = fields[field];
            const verifiedPhone = field === 'phone' ? phoneEvidence?.value : undefined;
            const value = verifiedPhone ?? stated?.value;
            if (value === null || value === undefined) continue; // null is not permission to erase.
            if (field === 'residenceCityId' && profile.residenceCityId !== value)
              await requireCity(tx, value);
            const current = profile[field];
            const conflict =
              (current !== null && current !== value) ||
              (field === 'phone' &&
                current !== value &&
                (await this.phoneTaken(tx, companyId, value, profile.id)));
            const applied = !conflict;
            review ||= conflict;
            identityReview ||= conflict;
            changed ||=
              conflict ||
              current !== value ||
              (field === 'phone' && !!verifiedPhone && !profile.phoneVerified);
            if (applied) {
              data[field] = value;
              if (field === 'phone' && verifiedPhone) data.phoneVerified = true;
            }
            evidence.push({
              profileId: profile.id,
              operationId,
              field,
              value,
              source: verifiedPhone ? phoneEvidence!.kind : 'CUSTOMER_STATEMENT',
              verified: !!verifiedPhone,
              applied,
              messageId: stated?.messageId,
              observedAt: new Date(input.sender.observedAt),
            });
            // A conflicting typed phone accompanying verified metadata is a separate proposal.
            if (
              field === 'phone' &&
              verifiedPhone &&
              stated?.value &&
              stated.value !== verifiedPhone
            ) {
              review = true;
              identityReview = true;
              changed = true;
              evidence.push({
                profileId: profile.id,
                operationId,
                field,
                value: stated.value,
                source: 'CUSTOMER_STATEMENT',
                verified: false,
                applied: false,
                messageId: stated.messageId,
                observedAt: new Date(input.sender.observedAt),
              });
            }
          }
          const observedAt = new Date(input.sender.observedAt);
          if (observedAt >= identity.observedAt) {
            const username = input.sender.username ?? identity.username;
            const displayName = input.sender.displayName ?? identity.displayName;
            changed ||= username !== identity.username || displayName !== identity.displayName;
            await tx.customerChannelIdentity.update({
              where: { id: identity.id },
              data: { username, displayName, observedAt },
            });
          }
          if ('intent' in input) {
            await requireCity(tx, input.residenceCityId);
            // The same lock is required by every staff rule write.
            await identityLock(tx, `${companyId}:followup-rules`);
            const rules = await tx.customerFollowUpRule.findMany({
              where: {
                companyId,
                isActive: true,
                residenceCityId: input.residenceCityId,
                serviceCode: input.serviceCode ?? null,
              },
            });
            const ids = [
              ...(await lockActiveBranches(
                tx,
                rules.map((r) => r.branchId),
              )),
            ];
            if (
              profile.residenceCityId &&
              profile.residenceCityId !== input.residenceCityId &&
              input.intent !== 'PERMANENT_MOVE'
            )
              identityError(409, 'FOLLOWUP_MOVE_CONFIRMATION_REQUIRED');
            data.residenceCityId = input.residenceCityId;
            evidence.push({
              profileId: profile.id,
              operationId,
              field: 'residenceCityId',
              value: input.residenceCityId,
              source: 'CUSTOMER_STATEMENT',
              verified: false,
              applied: true,
              messageId: input.messageId,
              observedAt: new Date(input.sender.observedAt),
            });
            if (profile.followUpBranchId && input.intent !== 'PERMANENT_MOVE') {
              identityError(409, 'FOLLOWUP_MOVE_CONFIRMATION_REQUIRED');
            }
            const activeRules = rules.filter((r) => ids.includes(r.branchId));
            const selected = activeRules.length === 1 ? activeRules[0]!.branchId : null;
            if (selected && !client.branches.some((b) => b.branchId === selected))
              identityError(403, 'CHANNEL_NOT_ALLOWED');
            reason = selected ? null : ids.length ? 'SEVERAL_RULES' : 'NO_RULE';
            data.followUpReview = !selected;
            if (selected) {
              data.followUpBranchId = selected;
              data.residenceCityId = input.residenceCityId;
            }
            review ||= !selected;
            changed = true;
          }
          data.needsReview = identityReview;
          if (changed && !created) data.version = { increment: 1 };
          profile = await tx.customerProfile.update({ where: { id: profile.id }, data });
        }
        const body: IdentityResult = {
          schemaVersion: IDENTITY_VERSION,
          operationId,
          outcome: identity.blocked
            ? 'REJECTED'
            : review
              ? 'NEEDS_REVIEW'
              : created
                ? 'CREATED'
                : requestedProfile && changed
                  ? 'UPDATED'
                  : 'RESTORED',
          profileId: profile?.id ?? null,
          profileVersion: profile?.version ?? null,
          missing: profile
            ? ['name', 'phone', 'residenceCityId'].filter(
                (f) => profile[f as keyof CustomerProfile] === null,
              )
            : ['name', 'phone', 'residenceCityId'],
          followUp: {
            status: profile?.followUpReview
              ? 'NEEDS_REVIEW'
              : profile?.followUpBranchId
                ? 'ASSIGNED'
                : review
                  ? 'NEEDS_REVIEW'
                  : 'UNASSIGNED',
            branchId: profile?.followUpBranchId ?? null,
            reason:
              reason ??
              (!profile?.residenceCityId && !profile?.followUpBranchId ? 'NO_RESIDENCE' : null),
          },
        };
        await tx.customerProfileOperation.create({
          data: {
            id: operationId,
            companyId,
            apiClientId: clientId,
            identityId: identity.id,
            idempotencyKey: envelope.idempotencyKey,
            contentHash: hash,
            result: json(body),
            context: json(envelope.context),
          },
        });
        if (evidence.length) await tx.customerProfileEvidence.createMany({ data: evidence });
        if ('intent' in input && profile) {
          await tx.customerFollowUpHistory.create({
            data: {
              profileId: profile.id,
              operationId,
              beforeBranchId: beforeBranchId,
              afterBranchId: profile.followUpBranchId,
              reason: reason ?? input.intent,
            },
          });
        }
        return { created, body };
      })
      .catch((error: unknown) => {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          ['P1001', 'P1002', 'P2024', 'P2028', 'P2034'].includes(error.code)
        )
          identityError(503, 'CUSTOMER_CAPTURE_UNAVAILABLE');
        throw error;
      });
  }

  async lockProfile(tx: Tx, id: string): Promise<CustomerProfile> {
    await tx.$queryRaw`SELECT id FROM customer_profiles WHERE id = ${id}::uuid AND company_id = ${this.auth.companyId} FOR UPDATE`;
    const row = await tx.customerProfile.findFirst({
      where: { id, companyId: this.auth.companyId },
    });
    if (!row) identityError(404, 'PROFILE_NOT_BOUND');
    return row;
  }

  /** The capture id is not a read grant. Booking links require the same signed conversation. */
  async requireBookingBindingInTx(
    tx: Tx,
    clientId: string,
    binding: ProfileBookingBinding,
  ): Promise<CustomerProfile> {
    this.requireBookingEnabled();
    await this.requireKey(tx, clientId);
    const conversation = await tx.customerProfileConversation.findUnique({
      where: {
        companyId_apiClientId_conversationId: {
          companyId: this.auth.companyId,
          apiClientId: clientId,
          conversationId: binding.conversationId,
        },
      },
      include: { identity: true },
    });
    if (
      !conversation ||
      conversation.identity.blocked ||
      conversation.identity.profileId !== binding.profileId ||
      conversation.identity.channel !== binding.context.channel ||
      conversation.identity.subjectId !== binding.context.subjectId
    ) {
      identityError(404, 'PROFILE_NOT_BOUND');
    }
    return this.lockProfile(tx, binding.profileId);
  }

  async phoneTaken(tx: Tx, companyId: string, value: string, exceptId?: string): Promise<boolean> {
    const profiles = await tx.customerProfile.count({
      where: { companyId, phone: value, ...(exceptId ? { id: { not: exceptId } } : {}) },
    });
    // Existing branch accounts have no trusted channel ownership: never auto-link by their phone.
    const old = await this.customers.profilePhoneOwnersInTx(tx, value, exceptId);
    if (old.some((r) => r.profileId === null)) return true;
    const owned = await tx.customerProfile.count({
      where: { companyId, id: { in: old.flatMap((r) => r.profileId ?? []) } },
    });
    return profiles > 0 || owned > 0;
  }

  async result(clientId: string, id: string, envelope: IdentityEnvelope): Promise<IdentityResult> {
    return this.prisma.$transaction(async (tx) => {
      await this.requireKey(tx, clientId);
      const row = await tx.customerProfileOperation.findFirst({
        where: { id, companyId: this.auth.companyId, apiClientId: clientId },
        include: { identity: true },
      });
      if (!row || !sameSender(row.identity, envelope)) identityError(404, 'OPERATION_NOT_FOUND');
      requireUnexpired(row.createdAt);
      return row.result as unknown as IdentityResult;
    });
  }

  /** Current accepted values only. A signed sender and this key's existing conversation are required. */
  async self(
    clientId: string,
    conversationId: string,
    envelope: IdentityEnvelope,
  ): Promise<SelfProfileResult> {
    return this.prisma.$transaction(async (tx) => {
      await this.requireKey(tx, clientId);
      // Same order as capture / human identity resolution; serializes blocking/linking with the read.
      await identityLock(
        tx,
        `${this.auth.companyId}:identity:${envelope.context.channel}:${envelope.context.subjectId}`,
      );
      const conversation = await tx.customerProfileConversation.findUnique({
        where: {
          companyId_apiClientId_conversationId: {
            companyId: this.auth.companyId,
            apiClientId: clientId,
            conversationId,
          },
        },
        include: { identity: true },
      });
      if (
        !conversation ||
        !sameSender(conversation.identity, envelope) ||
        conversation.identity.blocked
      )
        identityError(404, 'PROFILE_NOT_BOUND');
      if (!conversation.identity.profileId) identityError(409, 'IDENTITY_REVIEW_REQUIRED');
      const id = conversation.identity.profileId;
      // Keep version, values, and provenance in one consistent read relative to all profile writers.
      await tx.$queryRaw`SELECT id FROM customer_profiles WHERE id = ${id}::uuid AND company_id = ${this.auth.companyId} FOR SHARE`;
      const profile = await tx.customerProfile.findFirst({
        where: { id, companyId: this.auth.companyId },
      });
      if (!profile) identityError(404, 'PROFILE_NOT_BOUND');
      const fields = {} as SelfProfileResult['fields'];
      for (const field of PROFILE_FIELDS) {
        const value = profile[field];
        if (value === null) {
          fields[field] = { value: null, source: null, verification: 'MISSING', observedAt: null };
          continue;
        }
        const proof = await tx.customerProfileEvidence.findFirst({
          where: { profileId: profile.id, field, value, applied: true },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          select: { source: true, verified: true, observedAt: true },
        });
        let source: SelfProfileField['source'] = 'UNRECORDED';
        if (
          proof?.source === 'CUSTOMER_STATEMENT' ||
          (field === 'phone' &&
            (proof?.source === 'WHATSAPP_SENDER' || proof?.source === 'TELEGRAM_OWN_CONTACT'))
        )
          source = proof.source;
        const channelVerified =
          field === 'phone' &&
          profile.phoneVerified &&
          proof?.verified &&
          (source === 'WHATSAPP_SENDER' || source === 'TELEGRAM_OWN_CONTACT');
        fields[field] = {
          value,
          source,
          verification:
            source === 'UNRECORDED'
              ? 'UNKNOWN'
              : channelVerified
                ? 'CHANNEL_VERIFIED'
                : 'UNVERIFIED',
          observedAt: source === 'UNRECORDED' ? null : proof!.observedAt.toISOString(),
        };
      }
      return {
        schemaVersion: IDENTITY_VERSION,
        profileId: profile.id,
        profileVersion: profile.version,
        fields,
        missing: PROFILE_FIELDS.filter((field) => profile[field] === null),
        needsReview: profile.needsReview,
        followUp: {
          status: profile.followUpReview
            ? 'NEEDS_REVIEW'
            : profile.followUpBranchId
              ? 'ASSIGNED'
              : 'UNASSIGNED',
          branchId: profile.followUpBranchId,
          reason: profile.followUpReview
            ? 'REVIEW_REQUIRED'
            : !profile.residenceCityId && !profile.followUpBranchId
              ? 'NO_RESIDENCE'
              : null,
        },
      };
    });
  }
}

function sameSender(
  identity: { channel: string; subjectId: string },
  envelope: IdentityEnvelope,
): boolean {
  return (
    identity.channel === envelope.context.channel &&
    identity.subjectId === envelope.context.subjectId
  );
}
function requireUnexpired(createdAt: Date): void {
  if (Date.now() - createdAt.getTime() >= 90 * DAY) identityError(410, 'OPERATION_RESULT_EXPIRED');
}
async function requireCity(tx: Tx, id: string): Promise<void> {
  const rows = await tx.$queryRaw<
    { id: string }[]
  >`SELECT id FROM locations WHERE id = ${id}::uuid AND kind = 'CITY' AND is_active FOR SHARE`;
  if (!rows.length) identityError(400, 'INVALID_INPUT');
}
