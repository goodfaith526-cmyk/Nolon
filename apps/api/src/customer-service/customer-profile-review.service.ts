import { Injectable } from '@nestjs/common';
import type { AuthUser } from '../auth/auth-user.js';
import { assertBranchAccess } from '../auth/branch-scope.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import { nextSequenceValue } from '../common/numbering.js';
import { lockActiveBranches } from '../common/branch-locks.js';
import { CustomerIdentityAuth, identityError } from './customer-identity-auth.js';
import { CustomerIdentityService, identityLock } from './customer-identity.service.js';
import { CustomersService } from '../customers/customers.service.js';
import type { CustomerChatWarningsDto } from '@nolon/shared';

/** Explicit, opt-in global identity permissions. No account balances/documents in these replies. */
@Injectable()
export class CustomerProfileReviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: CustomerIdentityAuth,
    private readonly identity: CustomerIdentityService,
    private readonly customers: CustomersService,
  ) {}

  async get(id: string) {
    this.auth.enabled();
    const row = await this.prisma.customerProfile.findFirst({
      where: { id, companyId: this.auth.companyId },
      select: {
        id: true,
        number: true,
        name: true,
        phone: true,
        phoneVerified: true,
        needsReview: true,
        residenceCityId: true,
        followUpBranchId: true,
        followUpReview: true,
        version: true,
      },
    });
    if (!row) identityError(404, 'PROFILE_NOT_BOUND');
    return row;
  }
  async intake(page: number) {
    this.auth.enabled();
    const identities = await this.prisma.customerChannelIdentity.findMany({
      where: { companyId: this.auth.companyId, profileId: null, blocked: false },
      select: { id: true, channel: true, pending: true, createdAt: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      skip: (page - 1) * 50,
      take: 50,
    });
    const profiles = await this.prisma.customerProfile.findMany({
      where: { companyId: this.auth.companyId, needsReview: true },
      select: {
        id: true,
        number: true,
        name: true,
        phone: true,
        version: true,
        evidence: { where: { applied: false }, orderBy: { createdAt: 'desc' }, take: 20 },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      skip: (page - 1) * 50,
      take: 50,
    });
    return { identities, profiles };
  }

  /** Reject disputed proposals, preserving the current values. Existing-profile merges are separate. */
  async keepCurrent(user: AuthUser, id: string, expectedVersion: number, proofNote: string) {
    this.auth.enabled();
    return this.prisma.$transaction(async (tx) => {
      const profile = await this.identity.lockProfile(tx, id);
      if (profile.version !== expectedVersion) identityError(409, 'VERSION_CONFLICT');
      if (!profile.needsReview) identityError(409, 'PROFILE_NOT_AWAITING_REVIEW');
      const after = await tx.customerProfile.update({
        where: { id },
        data: { needsReview: false, version: { increment: 1 } },
      });
      await tx.customerProfileReview.create({
        data: {
          companyId: this.auth.companyId,
          actorId: user.id,
          entityId: id,
          action: 'REJECT_PROPOSALS',
          reason: proofNote,
          snapshot: { beforeVersion: expectedVersion, afterVersion: after.version },
        },
      });
      return { profileId: id, profileVersion: after.version };
    });
  }
  /**
   * Owner, 2026-11-07: the chat's doubtful values on a customer's file, for staff: each value the
   * chat brought that was not put in the file (another name, a phone another file has or a second
   * phone, another address or city) since staff last marked the warnings seen. Values only; the
   * file is unchanged. A customer the user may not see is a 404, as its page.
   */
  async customerWarnings(user: AuthUser, customerId: string): Promise<CustomerChatWarningsDto> {
    await this.customers.get(user, customerId);
    const customer = await this.prisma.customer.findUniqueOrThrow({
      where: { id: customerId },
      select: { profileId: true },
    });
    const profile = customer.profileId
      ? await this.prisma.customerProfile.findFirst({
          where: { id: customer.profileId, companyId: this.auth.companyId },
          select: { id: true, version: true, needsReview: true },
        })
      : null;
    if (!profile?.needsReview)
      return {
        profileId: profile?.id ?? null,
        profileVersion: profile?.version ?? null,
        warnings: [],
      };
    const seen = await this.prisma.customerProfileReview.findFirst({
      where: { companyId: this.auth.companyId, entityId: profile.id, action: 'REJECT_PROPOSALS' },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    const rows = await this.prisma.customerProfileEvidence.findMany({
      where: {
        profileId: profile.id,
        applied: false,
        ...(seen ? { createdAt: { gt: seen.createdAt } } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 50,
      select: { field: true, value: true, observedAt: true },
    });
    const warnings: CustomerChatWarningsDto['warnings'] = [];
    for (const row of rows) {
      if (warnings.some((w) => w.field === row.field && w.value === row.value)) continue;
      if (warnings.length === 20) break;
      let value = row.value;
      let heldBy: string[] = [];
      if (row.field === 'residenceCityId') {
        const city = await this.prisma.location.findUnique({
          where: { id: row.value },
          select: { nameAr: true },
        });
        value = city?.nameAr ?? row.value;
      }
      if (row.field === 'phone') {
        // As phoneTaken counts holders (F227-2): customers by digits of phone or WhatsApp, and
        // other profiles with the phone, by their customer's number or else their own.
        const numbers = await this.customers.phoneHolderNumbers(row.value, customerId);
        const profiles = await this.prisma.customerProfile.findMany({
          where: { companyId: this.auth.companyId, phone: row.value, id: { not: profile.id } },
          orderBy: { number: 'asc' },
          take: 5,
          select: { number: true, accounts: { select: { number: true } } },
        });
        for (const p of profiles)
          if (!p.accounts.some((a) => numbers.includes(a.number)))
            numbers.push(p.accounts[0]?.number ?? p.number);
        heldBy = [...new Set(numbers)].slice(0, 5);
      }
      warnings.push({
        field:
          row.field === 'residenceCityId' ? 'city' : (row.field as 'name' | 'phone' | 'address'),
        value,
        heldBy,
        observedAt: row.observedAt.toISOString(),
      });
    }
    return { profileId: profile.id, profileVersion: profile.version, warnings };
  }

  /** Staff saw the chat warnings: the file stays as it is, and only newer warnings show. */
  async dismissCustomerWarnings(user: AuthUser, customerId: string, expectedVersion: number) {
    await this.customers.get(user, customerId);
    const customer = await this.prisma.customer.findUniqueOrThrow({
      where: { id: customerId },
      select: { profileId: true },
    });
    if (!customer.profileId) identityError(409, 'PROFILE_NOT_AWAITING_REVIEW');
    return this.keepCurrent(
      user,
      customer.profileId,
      expectedVersion,
      'Staff saw the chat warnings on the customer file',
    );
  }

  async rules() {
    this.auth.enabled('followup');
    return this.prisma.customerFollowUpRule.findMany({
      where: { companyId: this.auth.companyId },
      orderBy: { id: 'asc' },
    });
  }
  async rule(
    user: AuthUser,
    id: string,
    input: {
      expectedVersion: number;
      residenceCityId: string;
      serviceCode?: string | null;
      branchId: string;
      isActive: boolean;
    },
  ) {
    this.auth.enabled('followup');
    assertBranchAccess(user, input.branchId);
    return this.prisma.$transaction(async (tx) => {
      await identityLock(tx, `${this.auth.companyId}:followup-rules`);
      const before = await tx.customerFollowUpRule.findUnique({ where: { id } });
      if (before && before.companyId !== this.auth.companyId)
        identityError(404, 'PROFILE_NOT_BOUND');
      if ((before?.version ?? 0) !== input.expectedVersion) identityError(409, 'VERSION_CONFLICT');
      if (before) assertBranchAccess(user, before.branchId);
      const city = await tx.location.findFirst({
        where: {
          id: input.residenceCityId,
          kind: 'CITY',
          ...(input.isActive ? { isActive: true } : {}),
        },
      });
      if (
        !city ||
        (input.isActive && !(await lockActiveBranches(tx, [input.branchId])).has(input.branchId))
      )
        identityError(400, 'INVALID_INPUT');
      const data = {
        residenceCityId: input.residenceCityId,
        serviceCode: input.serviceCode ?? null,
        branchId: input.branchId,
        isActive: input.isActive,
      };
      const row = before
        ? await tx.customerFollowUpRule.update({
            where: { id },
            data: { ...data, version: { increment: 1 } },
          })
        : await tx.customerFollowUpRule.create({
            data: { id, companyId: this.auth.companyId, ...data },
          });
      await tx.customerProfileReview.create({
        data: {
          companyId: this.auth.companyId,
          actorId: user.id,
          entityId: id,
          action: 'FOLLOWUP_RULE',
          reason: 'Explicit staff routing rule',
          snapshot: JSON.parse(JSON.stringify({ before, after: row })) as Prisma.InputJsonValue,
        },
      });
      return row;
    });
  }

  /** A human confirms ownership; never an automatic match/merge of two existing profiles. */
  async resolve(
    user: AuthUser,
    identityId: string,
    input: { accountId?: string; profileId?: string; proofNote: string },
  ) {
    this.auth.enabled();
    return this.prisma.$transaction(async (tx) => {
      // Read selector first, then the identical advisory lock used by channel capture.
      const before = await tx.customerChannelIdentity.findFirst({
        where: { id: identityId, companyId: this.auth.companyId },
      });
      if (!before) identityError(404, 'PROFILE_NOT_BOUND');
      await identityLock(
        tx,
        `${this.auth.companyId}:identity:${before.channel}:${before.subjectId}`,
      );
      const current = await tx.customerChannelIdentity.findUniqueOrThrow({
        where: { id: identityId },
      });
      if (current.profileId || current.blocked) identityError(409, 'IDENTITY_ALREADY_RESOLVED');
      let profileId = input.profileId;
      if (input.accountId) {
        await identityLock(tx, `${this.auth.companyId}:legacy-account:${input.accountId}`);
        const held = await this.customers.profileLinkCandidateInTx(tx, user, input.accountId);
        if (held?.profileId) await this.identity.lockProfile(tx, held.profileId);
        const account = await this.customers.profileLinkCandidateInTx(
          tx,
          user,
          input.accountId,
          true,
        );
        if (!account) identityError(404, 'PROFILE_NOT_BOUND');
        if (!account.isActive) identityError(409, 'CUSTOMER_INACTIVE');
        profileId =
          account.profileId ??
          (
            await tx.customerProfile.create({
              data: {
                companyId: this.auth.companyId,
                number: `CP${(await nextSequenceValue(tx, 'CUSTOMER_PROFILE')).toString().padStart(6, '0')}`,
                name: account.name,
                phone: account.phone,
                address: account.address?.slice(0, 1000),
              },
            })
          ).id;
        await this.customers.linkProfileInTx(tx, user, account.id, profileId);
      }
      if (!profileId) identityError(400, 'INVALID_INPUT');
      const profile = await this.identity.lockProfile(tx, profileId);
      await tx.customerChannelIdentity.update({ where: { id: identityId }, data: { profileId } });
      await tx.customerProfile.update({
        where: { id: profile.id },
        data: { version: { increment: 1 } },
      });
      await tx.customerProfileReview.create({
        data: {
          companyId: this.auth.companyId,
          actorId: user.id,
          entityId: identityId,
          action: 'IDENTITY_LINK',
          reason: input.proofNote,
          snapshot: { profileId, accountId: input.accountId ?? null },
        },
      });
      return { profileId, profileVersion: profile.version + 1 };
    });
  }
}
