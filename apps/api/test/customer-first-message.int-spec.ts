import { createHmac, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newApiKey } from '../src/customer-service/api-key.js';
import { sha256 } from '../src/customer-service/customer-identity-auth.js';
import type { IdentityResult } from '../src/customer-service/customer-identity.contract.js';
import { CustomersService } from '../src/customers/customers.service.js';
import {
  branchId,
  createTestApp,
  createUser,
  LEDGER_PREFIX,
  type TestApp,
} from './auth-test-app.js';
import { waitForLockWaiter } from './test-data.js';

/**
 * Plan 09d section 4a (owner, 2026-11-04): the customer is registered in NOLON from the first
 * message the agent captures, before any staff sees a booking and even with no booking at all.
 */
describe('A central customer from the first message (plan 09d 4a)', () => {
  let t: TestApp;
  let dxb = '';
  let jed = '';
  let creatorId = '';
  const clientId = randomUUID();
  const secret = 'test-channel-assertion-secret-32-characters';
  const key = newApiKey();
  const companyId = `first-${randomUUID()}`;
  const sender = (extra: object = {}) => ({
    channel: 'TELEGRAM',
    subjectId: `${Date.now()}${Math.floor(Math.random() * 100000)}`,
    channelAccountId: 'test-bot',
    eventId: randomUUID(),
    observedAt: new Date().toISOString(),
    ...extra,
  });
  type Sender = ReturnType<typeof sender>;
  const capture = (from: Sender) => ({
    schemaVersion: 'nolon.customer-identity/1',
    conversationId: randomUUID(),
    sender: from,
    fields: {},
  });
  function post(body: ReturnType<typeof capture>) {
    const rawBody = JSON.stringify(body);
    const { channel, subjectId, channelAccountId, eventId, observedAt } = body.sender;
    const rawContext = JSON.stringify({
      channel,
      subjectId,
      channelAccountId,
      eventId,
      observedAt,
    });
    const issued = Math.floor(Date.now() / 1000).toString();
    const path = '/api/v1/cs/customer-profiles/capture';
    const idem = randomUUID();
    const payload = [
      'v1',
      clientId,
      'POST',
      path,
      idem,
      issued,
      sha256(rawContext),
      sha256(rawBody),
    ].join('\n');
    const signature = createHmac('sha256', secret).update(payload).digest('base64url');
    return t
      .http()
      .post(path)
      .set('Authorization', `Bearer ${key.key}`)
      .set('X-Nolon-Channel-Assertion', `v1:${issued}:${signature}`)
      .set('X-Nolon-Channel-Context', Buffer.from(rawContext).toString('base64url'))
      .set('Idempotency-Key', idem)
      .set('Content-Type', 'application/json')
      .send(rawBody);
  }
  const accountsOf = (profileId: string) =>
    t.prisma.customer.findMany({ where: { profileId }, orderBy: { createdAt: 'asc' } });

  beforeAll(async () => {
    t = await createTestApp({
      CS_CUSTOMER_IDENTITY_ENABLED: true,
      CS_CUSTOMER_IDENTITY_ACCOUNT_ENABLED: true,
      CS_CUSTOMER_IDENTITY_COMPANY_ID: companyId,
      CS_CUSTOMER_IDENTITY_CLIENTS: JSON.stringify({
        [clientId]: { secret, accounts: [{ channel: 'TELEGRAM', channelAccountId: 'test-bot' }] },
      }),
    });
    const user = await createUser(t.prisma, ['ADMINISTRATOR'], [], LEDGER_PREFIX);
    creatorId = user.id;
    dxb = await branchId(t.prisma, 'DXB');
    jed = await branchId(t.prisma, 'JED');
    await t.prisma.apiClient.create({
      data: {
        id: clientId,
        name: 'First message test',
        keyPrefix: key.prefix,
        keyHash: key.hash,
        createdById: user.id,
        customersRead: false,
        branches: { create: [{ branchId: dxb }, { branchId: jed }] },
        scopes: { create: [{ scope: 'CUSTOMER_PROFILES_WRITE', grantedById: user.id }] },
      },
    });
  });
  afterAll(async () => {
    await t?.close();
  });

  it('registers one customer from the chat name on the first message, and only one', async () => {
    const from = sender({ displayName: 'Chat Name First' });
    const first = (await post(capture(from)).expect(201)).body as IdentityResult;
    const accounts = await accountsOf(first.profileId!);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({
      kind: 'INDIVIDUAL',
      name: 'Chat Name First',
      phone: null,
      createdViaApiClientId: clientId,
    });
    // The next message of the same person: the same customer, no other.
    await post(capture({ ...from, eventId: randomUUID(), observedAt: new Date().toISOString() }));
    expect(await accountsOf(first.profileId!)).toHaveLength(1);
    // Nothing else is written: no booking request, booking or invoice.
    expect(await t.prisma.booking.count({ where: { customerId: accounts[0]!.id } })).toBe(0);
    expect(await t.prisma.csBookingRequest.count({ where: { profileId: first.profileId! } })).toBe(
      0,
    );
  });

  it('registers no one without any name to show', async () => {
    const r = (await post(capture(sender())).expect(201)).body as IdentityResult;
    expect(await accountsOf(r.profileId!)).toHaveLength(0);
  });

  it('uses the oldest active account of a profile with several, never an inactive one', async () => {
    const r = (await post(capture(sender())).expect(201)).body as IdentityResult;
    const profile = await t.prisma.customerProfile.findUniqueOrThrow({
      where: { id: r.profileId! },
    });
    const make = (isActive: boolean, n: number) =>
      t.prisma.customer.create({
        data: {
          number: `ZZFM${randomUUID().slice(0, 8)}${n}`,
          name: 'Chat Name',
          kind: 'INDIVIDUAL',
          isActive,
          profileId: profile.id,
          createdById: creatorId,
        },
      });
    // Older data: an inactive account first, then an active one.
    const inactive = await make(false, 1);
    const active = await make(true, 2);
    await t.prisma.$transaction((tx) =>
      t.app.get(CustomersService).channelAccountInTx(tx, {
        profile: { ...profile, name: 'Full Given Name' },
        channelName: 'Chat Name',
        apiClientId: clientId,
      }),
    );
    const after = await accountsOf(profile.id);
    expect(after.map((a) => a.id)).toEqual([inactive.id, active.id]);
    expect(after.find((a) => a.id === active.id)?.name).toBe('Full Given Name');
    expect(after.find((a) => a.id === inactive.id)?.name).toBe('Chat Name');
  });
  it('never overwrites a staff correction made while it waited (F184-7)', async () => {
    const from = sender({ displayName: 'Chat Name Race' });
    const r = (await post(capture(from)).expect(201)).body as IdentityResult;
    const [account] = await accountsOf(r.profileId!);
    const profile = await t.prisma.customerProfile.findUniqueOrThrow({
      where: { id: r.profileId! },
    });
    const { pending } = await t.prisma.$transaction(
      async (tx) => {
        // Staff edit the customer and hold its row until they commit.
        await tx.customer.update({
          where: { id: account!.id },
          data: { name: 'Staff Verified Name' },
        });
        const sent = t.prisma
          .$transaction((other) =>
            t.app.get(CustomersService).channelAccountInTx(other, {
              profile: { ...profile, name: 'Given Bot Name' },
              channelName: 'Chat Name Race',
              apiClientId: clientId,
            }),
          )
          .then(() => 'done');
        await waitForLockWaiter(t.prisma, 1);
        return { pending: sent };
      },
      { timeout: 20_000 },
    );
    await pending;
    const after = await t.prisma.customer.findUniqueOrThrow({ where: { id: account!.id } });
    expect(after.name).toBe('Staff Verified Name');
  });
});
