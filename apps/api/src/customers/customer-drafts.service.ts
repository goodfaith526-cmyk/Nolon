import { Injectable, NotFoundException } from '@nestjs/common';
import type {
  CreateCustomerRequest,
  CustomerDraftCreateRequest,
  CustomerDraftDto,
  CustomerDraftListItemDto,
  CustomerDraftRequest,
  DraftStatus,
  EntryDraftCheck,
  EntryDraftSummaryDto,
} from '@nolon/shared';
import type { AuthUser } from '../auth/auth-user.js';
import { assertBranchAccess, branchScope } from '../auth/branch-scope.js';
import { throwFirstConflict } from '../common/rule-issues.js';
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
  replaceInTx,
  withReplaced,
  withReplacedBy,
} from '../drafts/drafts.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { CustomersService } from './customers.service.js';

const LABEL = 'customer draft';
const ASSISTANT_ONLY = 'Customer drafts are proposed by the assistant';
const HUMAN_ONLY = 'Only a person can decide on a customer draft';

const details = {
  branch: { select: { code: true } },
  createdBy: { select: { fullName: true } },
  decidedBy: { select: { fullName: true } },
  customer: { select: { number: true } },
} satisfies Prisma.CustomerDraftInclude;

type DraftRow = Prisma.CustomerDraftGetPayload<{ include: typeof details }>;

/** The customer a stored draft proposes. */
export function customerRequestOf(d: DraftRow): CustomerDraftRequest {
  return {
    kind: d.kind,
    name: d.name,
    companyName: d.companyName,
    phone: d.phone,
    whatsapp: d.whatsapp,
    email: d.email,
    city: d.city,
    address: d.address,
    notes: d.notes,
  };
}

/** sha256 of the normalised request (branch included): ids lower case, absent fields null. */
export function customerRequestHash(branchId: string, input: CustomerDraftRequest): string {
  return requestHash({
    branchId: branchId.toLowerCase(),
    kind: input.kind,
    name: input.name,
    companyName: input.companyName ?? null,
    phone: input.phone,
    whatsapp: input.whatsapp ?? null,
    email: input.email ?? null,
    city: input.city ?? null,
    address: input.address ?? null,
    notes: input.notes ?? null,
  });
}

function createRequestOf(branchId: string, input: CustomerDraftRequest): CreateCustomerRequest {
  return { branchId, ...input };
}

/**
 * New customers proposed by the staff AI assistant (entry drafts, src/drafts), so a booking or a
 * quotation can follow for someone not in NOLON yet. A person approves a draft on the review
 * screen, which creates the customer through CustomersService in the same transaction, with
 * their permissions and branches (a phone or tax number taken in the branch is checked under the
 * branch's customer lock); or rejects it. Drafts are branch-owned like customers. There is no
 * decision from the assistant's chat: a customer is master data a person reads in full first.
 */
@Injectable()
export class CustomerDraftsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly customers: CustomersService,
    private readonly drafts: DraftsService,
  ) {}

  async create(
    user: AuthUser,
    body: CustomerDraftCreateRequest,
    replacesDraftId: string | null = null,
  ): Promise<EntryDraftSummaryDto> {
    const agentClientId = await this.drafts.agentClientOf(user, ASSISTANT_ONLY);
    const { idempotencyKey, branchId, ...input } = body;
    // The checks of a real create that need no lock; nothing is written. A phone already taken
    // is refused now too (409), so the assistant can say so instead of proposing a duplicate; it
    // is checked again under the lock on approval.
    await this.customers.prepareCreate(user, createRequestOf(branchId, input));
    throwFirstConflict(
      await this.customers.duplicateIssues(this.prisma, [{ branchId, phone: input.phone }]),
    );
    const hash = withReplaced(customerRequestHash(branchId, input), replacesDraftId);
    const scope = { agentClientId, createdById: user.id, idempotencyKey };
    const id = await this.drafts.createIdempotently(() =>
      this.prisma.$transaction(async (tx) => {
        const existing = await tx.customerDraft.findUnique({
          where: { agentClientId_createdById_idempotencyKey: scope },
          select: { id: true, payloadHash: true },
        });
        if (existing) {
          if (existing.payloadHash !== hash) throw keyReused();
          return existing.id;
        }
        if (replacesDraftId !== null) {
          await replaceInTx(tx, {
            table: 'customer_drafts',
            id: replacesDraftId,
            agentClientId,
            userId: user.id,
            label: LABEL,
          });
        }
        const draft = await tx.customerDraft.create({
          data: {
            ...scope,
            replacesDraftId,
            branchId,
            expiresAt: draftExpiry(),
            payloadHash: hash,
            kind: input.kind,
            name: input.name,
            companyName: input.companyName ?? null,
            phone: input.phone,
            whatsapp: input.whatsapp ?? null,
            email: input.email ?? null,
            city: input.city ?? null,
            address: input.address ?? null,
            notes: input.notes ?? null,
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
    const draft = await this.prisma.customerDraft.findFirst({
      where: { agentClientId, createdById: user.id, idempotencyKey, ...branchScope(user) },
      include: details,
    });
    if (!draft) throw new NotFoundException('Customer draft not found');
    return toSummary(draft, new Date());
  }

  async list(user: AuthUser, status?: DraftStatus): Promise<CustomerDraftListItemDto[]> {
    const now = new Date();
    const drafts = await this.prisma.customerDraft.findMany({
      where: { ...branchScope(user), ...stateFilter(status, now) },
      include: details,
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return drafts.map((d) => ({ ...baseFields(d, user, now), lineCount: 1, phone: d.phone }));
  }

  async get(user: AuthUser, id: string): Promise<CustomerDraftDto> {
    return withReplacedBy(this.prisma, 'customer_drafts', await this.read(user, id));
  }

  private async read(user: AuthUser, id: string): Promise<CustomerDraftDto> {
    const draft = await this.findScoped(user, id);
    const now = new Date();
    const check =
      draftStatus(draft.state, draft.expiresAt, now) === 'DRAFT'
        ? await this.check(user, draft)
        : null;
    return { ...baseFields(draft, user, now), request: customerRequestOf(draft), check };
  }

  /**
   * A person approves the version they reviewed: the customer is created in the same transaction
   * as the approval. Approving an approved draft returns it as it is.
   */
  async approve(user: AuthUser, id: string, version: number): Promise<CustomerDraftDto> {
    this.drafts.requireHuman(user, HUMAN_ONLY);
    const current = await this.findScoped(user, id);
    if (current.state === 'APPROVED') return this.get(user, id);
    requireOpen(current, version, LABEL);
    const request = createRequestOf(current.branchId, customerRequestOf(current));
    await this.customers.prepareCreate(user, request);
    await this.prisma.$transaction(async (tx) => {
      let customerId = '';
      const decided = await decideInTx(tx, {
        table: 'customer_drafts',
        id,
        version,
        label: LABEL,
        approving: true,
        record: async () => {
          customerId = (await this.customers.createInTx(tx, user, request)).id;
        },
      });
      if (decided) {
        await tx.customerDraft.update({
          where: { id },
          data: { ...approvedFields(user), customerId },
        });
      }
    });
    return this.get(user, id);
  }

  async reject(
    user: AuthUser,
    id: string,
    input: { version: number; reason: string },
  ): Promise<CustomerDraftDto> {
    this.drafts.requireHuman(user, HUMAN_ONLY);
    await this.findScoped(user, id);
    await this.prisma.$transaction(async (tx) => {
      await decideInTx(tx, {
        table: 'customer_drafts',
        id,
        version: input.version,
        label: LABEL,
        approving: false,
      });
      await tx.customerDraft.update({
        where: { id },
        data: rejectedFields(user, input.reason),
      });
    });
    return this.get(user, id);
  }

  /** NOLON's checks of a create, the phone included (binding only under the lock, on approval). */
  private check(user: AuthUser, draft: DraftRow): Promise<EntryDraftCheck> {
    return checkDraft(async () => {
      assertBranchAccess(user, draft.branchId);
      await this.customers.prepareCreate(
        user,
        createRequestOf(draft.branchId, customerRequestOf(draft)),
      );
      throwFirstConflict(
        await this.customers.duplicateIssues(this.prisma, [
          { branchId: draft.branchId, phone: draft.phone },
        ]),
      );
      return { total: null, currency: null };
    });
  }

  private async findScoped(user: AuthUser, id: string): Promise<DraftRow> {
    const draft = await this.prisma.customerDraft.findFirst({
      where: { id, ...branchScope(user) },
      include: details,
    });
    if (!draft) throw new NotFoundException('Customer draft not found');
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
): Omit<CustomerDraftDto, 'request' | 'check'> {
  const status = draftStatus(d.state, d.expiresAt, now);
  const open = status === 'DRAFT' && !user.agent && user.permissions.has('customers:create');
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
    branchCode: d.branch.code,
    customerId: d.customerId,
    customerNumber: d.customer?.number ?? null,
  };
}
