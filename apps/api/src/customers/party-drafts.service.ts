import { Injectable, NotFoundException } from '@nestjs/common';
import type {
  DraftStatus,
  EntryDraftCheck,
  EntryDraftSummaryDto,
  PartyDraftCreateRequest,
  PartyDraftDto,
  PartyDraftListItemDto,
  PartyDraftRequest,
} from '@nolon/shared';
import type { AuthUser } from '../auth/auth-user.js';
import { branchScope } from '../auth/branch-scope.js';
import {
  approvedFields,
  checkDraft,
  draftExpiry,
  draftStatus,
  rejectedFields,
  requestHash,
  requireOpen,
  stateFilter,
} from '../drafts/draft-rules.js';
import {
  DraftsService,
  decideInTx,
  keyReused,
  lockReplacedInTx,
  replaceInTx,
  replacementParentIds,
  withReplaced,
  withReplacedBy,
} from '../drafts/drafts.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { CustomersService } from './customers.service.js';

const LABEL = 'party draft';
const ASSISTANT_ONLY = 'Party drafts are proposed by the assistant';
const HUMAN_ONLY = 'Only a person can decide on a party draft';

const details = {
  customer: { select: { number: true, name: true } },
  createdBy: { select: { fullName: true } },
  decidedBy: { select: { fullName: true } },
} satisfies Prisma.PartyDraftInclude;

type DraftRow = Prisma.PartyDraftGetPayload<{ include: typeof details }>;

/** The party a stored draft proposes. */
export function partyRequestOf(d: DraftRow): PartyDraftRequest {
  return {
    name: d.name,
    companyName: d.companyName,
    phone: d.phone,
    email: d.email,
    countryCode: d.countryCode,
    city: d.city,
    address: d.address,
  };
}

/** sha256 of the normalised request (customer included): ids lower case, absent fields null. */
export function partyRequestHash(customerId: string, input: PartyDraftRequest): string {
  return requestHash({
    customerId: customerId.toLowerCase(),
    name: input.name,
    companyName: input.companyName ?? null,
    phone: input.phone ?? null,
    email: input.email ?? null,
    countryCode: input.countryCode ?? null,
    city: input.city ?? null,
    address: input.address ?? null,
  });
}

/**
 * Parties of a customer (shipper, consignee, notify party) proposed by the staff AI assistant
 * (entry drafts, src/drafts), so a booking can name someone the customer ships for or to. A
 * person approves a draft on the review screen, which adds the party through CustomersService in
 * the same transaction, under the customer's lock, with their permissions; or rejects it. Access
 * follows the customer's branch. There is no decision from the assistant's chat.
 */
@Injectable()
export class PartyDraftsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly customers: CustomersService,
    private readonly drafts: DraftsService,
  ) {}

  async create(
    user: AuthUser,
    body: PartyDraftCreateRequest,
    replacesDraftId: string | null = null,
  ): Promise<EntryDraftSummaryDto> {
    const agentClientId = await this.drafts.agentClientOf(user, ASSISTANT_ONLY);
    const { idempotencyKey, customerId, ...input } = body;
    // The checks of a real addParty that need no lock; nothing is written.
    const prepared = await this.customers.prepareAddParty(user, customerId);
    const hash = withReplaced(partyRequestHash(customerId, input), replacesDraftId);
    const scope = { agentClientId, createdById: user.id, idempotencyKey };
    const id = await this.drafts.createIdempotently(() =>
      this.prisma.$transaction(async (tx) => {
        // An approval locks the customer, then the draft: a replacement takes the same order.
        if (replacesDraftId !== null) {
          const ids = await replacementParentIds(tx, 'party_drafts', replacesDraftId, customerId);
          for (const customer of ids) await this.customers.lockForPartyWrite(tx, customer);
        }
        // Locked before the key lookup: an identical retry waits here, then finds the winner.
        const replaced = await lockReplacedInTx(tx, replacesDraftId, {
          table: 'party_drafts',
          agentClientId,
          user,
          label: LABEL,
        });
        const existing = await tx.partyDraft.findUnique({
          where: { agentClientId_createdById_idempotencyKey: scope },
          select: { id: true, payloadHash: true },
        });
        if (existing) {
          if (existing.payloadHash !== hash) throw keyReused();
          return existing.id;
        }
        if (replaced) await replaceInTx(tx, replaced);
        const draft = await tx.partyDraft.create({
          data: {
            ...scope,
            replacesDraftId,
            branchId: prepared.branchId,
            customerId,
            expiresAt: draftExpiry(),
            payloadHash: hash,
            name: input.name,
            companyName: input.companyName ?? null,
            phone: input.phone ?? null,
            email: input.email ?? null,
            countryCode: input.countryCode ?? null,
            city: input.city ?? null,
            address: input.address ?? null,
          },
          select: { id: true },
        });
        return draft.id;
      }),
    );
    return toSummary(await this.findScoped(user, id), new Date());
  }

  async findByKey(user: AuthUser, idempotencyKey: string): Promise<EntryDraftSummaryDto> {
    const agentClientId = await this.drafts.agentClientOf(user, ASSISTANT_ONLY);
    const draft = await this.prisma.partyDraft.findFirst({
      where: { agentClientId, createdById: user.id, idempotencyKey, customer: branchScope(user) },
      include: details,
    });
    if (!draft) throw new NotFoundException('Party draft not found');
    return toSummary(draft, new Date());
  }

  async list(user: AuthUser, status?: DraftStatus): Promise<PartyDraftListItemDto[]> {
    const now = new Date();
    const drafts = await this.prisma.partyDraft.findMany({
      where: { customer: branchScope(user), ...stateFilter(status, now) },
      include: details,
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return drafts.map((d) => ({ ...baseFields(d, user, now), lineCount: 1 }));
  }

  async get(user: AuthUser, id: string): Promise<PartyDraftDto> {
    return withReplacedBy(this.prisma, 'party_drafts', await this.read(user, id));
  }

  private async read(user: AuthUser, id: string): Promise<PartyDraftDto> {
    const draft = await this.findScoped(user, id);
    const now = new Date();
    const check =
      draftStatus(draft.state, draft.expiresAt, now) === 'DRAFT'
        ? await this.check(user, draft)
        : null;
    return { ...baseFields(draft, user, now), request: partyRequestOf(draft), check };
  }

  /**
   * A person approves the version they reviewed: the party is added in the same transaction as
   * the approval. Locks the customer first, then the draft row, as every party change does.
   * Approving an approved draft returns it as it is.
   */
  async approve(user: AuthUser, id: string, version: number): Promise<PartyDraftDto> {
    this.drafts.requireDecider(user, 'SESSION', HUMAN_ONLY, id);
    const current = await this.findScoped(user, id);
    if (current.state === 'APPROVED') return this.get(user, id);
    requireOpen(current, version, LABEL);
    await this.customers.prepareAddParty(user, current.customerId);
    await this.prisma.$transaction(async (tx) => {
      let partyId = '';
      const decided = await decideInTx(tx, {
        table: 'party_drafts',
        id,
        version,
        label: LABEL,
        approving: true,
        lockParents: async () => {
          await this.customers.lockForPartyWrite(tx, current.customerId);
        },
        record: async () => {
          partyId = await this.customers.addPartyInTx(
            tx,
            user,
            current.customerId,
            partyRequestOf(current),
          );
        },
      });
      if (decided) {
        await tx.partyDraft.update({
          where: { id },
          data: { ...approvedFields(user, 'SESSION'), partyId },
        });
      }
    });
    return this.get(user, id);
  }

  async reject(
    user: AuthUser,
    id: string,
    input: { version: number; reason: string },
  ): Promise<PartyDraftDto> {
    this.drafts.requireDecider(user, 'SESSION', HUMAN_ONLY, id);
    await this.findScoped(user, id);
    await this.prisma.$transaction(async (tx) => {
      await decideInTx(tx, {
        table: 'party_drafts',
        id,
        version: input.version,
        label: LABEL,
        approving: false,
      });
      await tx.partyDraft.update({
        where: { id },
        data: rejectedFields(user, input.reason, 'SESSION'),
      });
    });
    return this.get(user, id);
  }

  /** NOLON's checks of adding the party now (checked again on approval). */
  private check(user: AuthUser, draft: DraftRow): Promise<EntryDraftCheck> {
    return checkDraft(async () => {
      await this.customers.prepareAddParty(user, draft.customerId);
      return { total: null, currency: null };
    });
  }

  private async findScoped(user: AuthUser, id: string): Promise<DraftRow> {
    const draft = await this.prisma.partyDraft.findFirst({
      where: { id, customer: branchScope(user) },
      include: details,
    });
    if (!draft) throw new NotFoundException('Party draft not found');
    return draft;
  }
}

function toSummary(d: DraftRow, now: Date): EntryDraftSummaryDto {
  return {
    id: d.id,
    status: draftStatus(d.state, d.expiresAt, now),
    version: d.version,
    lineCount: 1,
    expiresAt: d.expiresAt.toISOString(),
    createdAt: d.createdAt.toISOString(),
  };
}

function baseFields(
  d: DraftRow,
  user: AuthUser,
  now: Date,
): Omit<PartyDraftDto, 'request' | 'check'> {
  const status = draftStatus(d.state, d.expiresAt, now);
  const open = status === 'DRAFT' && !user.agent && user.permissions.has('customers:update');
  return {
    id: d.id,
    replacesDraftId: d.replacesDraftId,
    branchId: d.branchId,
    subject: d.name,
    status,
    version: d.version,
    expiresAt: d.expiresAt.toISOString(),
    createdAt: d.createdAt.toISOString(),
    createdByName: d.createdBy.fullName,
    decidedByName: d.decidedBy?.fullName ?? null,
    decidedFromAssistant: d.decidedVia === 'ASSISTANT',
    decidedAt: d.decidedAt?.toISOString() ?? null,
    rejectReason: d.rejectReason,
    actions: { canEdit: false, canDecide: open },
    customerId: d.customerId,
    customerNumber: d.customer.number,
    customerName: d.customer.name,
    partyId: d.partyId,
  };
}
