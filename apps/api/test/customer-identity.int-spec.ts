import { uniquePhone } from './test-data.js';
import { readFileSync } from 'node:fs';
import { backfillCustomerProfiles } from '../src/seed/customer-profile-backfill.js';
import { CustomerIdentityService } from '../src/customer-service/customer-identity.service.js';
import { createHmac, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createTestApp,
  createUser,
  branchId,
  signIn,
  APP_ORIGIN,
  LEDGER_PREFIX,
  type TestApp,
} from './auth-test-app.js';
import { newApiKey } from '../src/customer-service/api-key.js';
import { sha256 } from '../src/customer-service/customer-identity-auth.js';
import type {
  IdentityResult,
  SelfProfileResult,
} from '../src/customer-service/customer-identity.contract.js';

const bookingExamples = JSON.parse(
  readFileSync(
    new URL('../../../docs/plans/08c-customer-profile-booking-examples.json', import.meta.url),
    'utf8',
  ),
) as Record<'ids' | 'names', { body: Record<string, unknown>; response: { status: string } }>;

describe('Unified customer identity: trusted channel capture, not a read grant', () => {
  let t: TestApp;
  let staffCookie = '';
  let ordinaryCookie = '';
  let dxb = '';
  let jed = '';
  let creatorId = '';
  const originId = randomUUID();
  const destinationId = randomUUID();
  const category = `I${randomUUID().slice(0, 6).toUpperCase()}`;
  const clientId = randomUUID();
  const otherId = randomUUID();
  const secret = 'test-channel-assertion-secret-32-characters';
  const key = newApiKey();
  const otherKey = newApiKey();
  const companyId = `identity-${randomUUID()}`;
  const sender = (extra: object = {}) => ({
    channel: 'TELEGRAM',
    subjectId: `${Date.now()}${Math.floor(Math.random() * 100000)}`,
    channelAccountId: 'test-bot',
    eventId: randomUUID(),
    observedAt: new Date().toISOString(),
    ...extra,
  });
  const capture = (extra: object = {}) => ({
    schemaVersion: 'nolon.customer-identity/1',
    conversationId: randomUUID(),
    sender: sender(),
    fields: {},
    ...extra,
  });
  type Body = ReturnType<typeof capture>;
  function call(
    method: 'post' | 'patch' | 'get',
    path: string,
    body: object,
    idem: string = randomUUID(),
    client = clientId,
    token = key.key,
    override?: Body['sender'],
  ) {
    const rawBody = method === 'get' ? '' : JSON.stringify(body);
    const context = override ?? (method === 'get' ? body : (body as Body).sender);
    const { channel, subjectId, channelAccountId, eventId, observedAt } = context as Body['sender'];
    const rawContext = JSON.stringify({
      channel,
      subjectId,
      channelAccountId,
      eventId,
      observedAt,
    });
    const issued = Math.floor(Date.now() / 1000).toString();
    const fullPath = `/api/v1${path}`;
    const payload = [
      'v1',
      client,
      method.toUpperCase(),
      fullPath,
      method === 'get' ? '' : idem,
      issued,
      sha256(rawContext),
      sha256(rawBody),
    ].join('\n');
    const signature = createHmac('sha256', secret).update(payload).digest('base64url');
    const req = t
      .http()
      [method](fullPath)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Nolon-Channel-Assertion', `v1:${issued}:${signature}`)
      .set('X-Nolon-Channel-Context', Buffer.from(rawContext).toString('base64url'));
    if (method !== 'get')
      req.set('Idempotency-Key', idem).set('Content-Type', 'application/json').send(rawBody);
    return req;
  }
  const post = (body: object, idem: string = randomUUID()) =>
    call('post', '/cs/customer-profiles/capture', body, idem);
  const result = (response: { body: unknown }) => response.body as IdentityResult;
  beforeAll(async () => {
    const config = {
      secret,
      accounts: [
        { channel: 'TELEGRAM', channelAccountId: 'test-bot' },
        { channel: 'TELEGRAM', channelAccountId: 'nolon-booking' },
        { channel: 'WHATSAPP', channelAccountId: 'test-bot' },
      ],
    };
    t = await createTestApp({
      CS_CUSTOMER_IDENTITY_ENABLED: true,
      CS_CUSTOMER_FOLLOWUP_ENABLED: true,
      CS_CUSTOMER_BOOKING_IDENTITY_ENABLED: true,
      CS_CUSTOMER_IDENTITY_COMPANY_ID: companyId,
      CS_CUSTOMER_IDENTITY_CLIENTS: JSON.stringify({ [clientId]: config, [otherId]: config }),
    });
    const user = await createUser(t.prisma, ['ADMINISTRATOR'], [], LEDGER_PREFIX);
    creatorId = user.id;
    dxb = await branchId(t.prisma, 'DXB');
    jed = await branchId(t.prisma, 'JED');
    const ordinary = await createUser(t.prisma, ['SALES'], ['DXB', 'JED'], LEDGER_PREFIX);
    ordinaryCookie = await signIn(t, ordinary.email);
    const reviewer = await createUser(t.prisma, ['SALES'], ['DXB', 'JED'], LEDGER_PREFIX);
    for (const permission of [
      'customer_profiles:view',
      'customer_profile_intake:view',
      'customer_profile_intake:update',
      'customer_profile_followup:update',
    ]) {
      await t.prisma.userBranchPermission.create({
        data: {
          userId: reviewer.id,
          branchId: dxb,
          permission,
          effect: 'ALLOW',
          sourceKey: '00000000-0000-0000-0000-000000000000',
          createdById: user.id,
        },
      });
    }
    staffCookie = await signIn(t, reviewer.email);
    await t.prisma.currency.upsert({
      where: { code: 'USD' },
      create: { code: 'USD', nameEn: 'US Dollar', nameAr: 'دولار', decimalPlaces: 2 },
      update: {},
    });
    await t.prisma.priceCategory.create({
      data: {
        code: category,
        nameEn: category,
        nameAr: category,
        cargoType: 'GENERAL',
        defaultUnit: 'PER_SHIPMENT',
      },
    });
    for (const [id, suffix] of [
      [originId, 'O'],
      [destinationId, 'D'],
    ] as const) {
      await t.prisma.location.create({
        data: {
          id,
          code: `${category}${suffix}`,
          nameEn: `${category}${suffix}`,
          nameAr: 'مدينة اختبار',
          kind: 'CITY',
          countryCode: 'AE',
        },
      });
    }
    await t.prisma.branchRoutingRule.create({ data: { locationId: originId, branchId: dxb } });
    for (const [id, k] of [
      [clientId, key],
      [otherId, otherKey],
    ] as const) {
      await t.prisma.apiClient.create({
        data: {
          id,
          name: 'Identity test',
          keyPrefix: k.prefix,
          keyHash: k.hash,
          createdById: user.id,
          customersRead: false,
          branches: { create: [{ branchId: dxb }, { branchId: jed }] },
          scopes: {
            create: [
              { scope: 'CUSTOMER_PROFILES_WRITE', grantedById: user.id },
              { scope: 'BOOKING_REQUESTS_CREATE', grantedById: user.id },
            ],
          },
        },
      });
    }
  });
  afterAll(async () => {
    await t?.close();
  });

  it('executes the shared contract first-contact and exact-replay fixtures without renaming fields', async () => {
    const fixtures = JSON.parse(
      readFileSync(
        new URL('../../../docs/plans/08a-bot-customer-identity-examples.json', import.meta.url),
        'utf8',
      ),
    ) as {
      cases: {
        id: string;
        request?: { body?: Body; idempotencyKey?: string };
        expected?: { body?: IdentityResult };
      }[];
    };
    const fixture = fixtures.cases.find((c) => c.id === 'telegram-empty-first-contact')!;
    const replay = fixtures.cases.find((c) => c.id === 'exact-retry-after-response-loss')!;
    const first = result(
      await post(fixture.request!.body!, fixture.request!.idempotencyKey).expect(201),
    );
    expect(first).toEqual({
      ...fixture.expected!.body!,
      profileId: first.profileId,
      operationId: first.operationId,
    });
    expect(
      result(await post(replay.request!.body!, replay.request!.idempotencyKey).expect(200)),
    ).toEqual(first);
  });
  it('creates a real unified profile on first contact without name, phone or username; no branch account or booking', async () => {
    const input = capture();
    const r = result(await post(input).expect(201));
    expect(r.outcome).toBe('CREATED');
    expect(r.profileVersion).toBe(1);
    expect(r.followUp.status).toBe('UNASSIGNED');
    const profile = await t.prisma.customerProfile.findUniqueOrThrow({
      where: { id: r.profileId! },
    });
    expect(profile).toMatchObject({
      name: null,
      phone: null,
      residenceCityId: null,
      followUpBranchId: null,
      companyId,
    });
    expect(
      await t.prisma.customerProfileOperation.count({
        where: { id: r.operationId, actor: 'ai_agent' },
      }),
    ).toBe(1);
  });
  it('offers active residence cities and aliases without inferring a route or branch', async () => {
    const alias = `Residence-${randomUUID().slice(0, 8)}`;
    await t.prisma.locationAlias.create({ data: { locationId: originId, alias } });
    const input = capture();
    const path = `/cs/customer-profiles/residence-cities?q=${alias}`;
    const found = await call('get', path, {}, '', clientId, key.key, input.sender).expect(200);
    expect(found.body as unknown).toEqual({
      items: [
        {
          id: originId,
          code: `${category}O`,
          nameAr: 'مدينة اختبار',
          nameEn: `${category}O`,
          countryCode: 'AE',
          aliases: [{ alias }],
        },
      ],
      nextPage: null,
    });
    await t.prisma.location.update({ where: { id: originId }, data: { isActive: false } });
    try {
      const absent = await call('get', path, {}, '', clientId, key.key, input.sender).expect(200);
      expect(absent.body as unknown).toEqual({ items: [], nextPage: null });
    } finally {
      await t.prisma.location.update({ where: { id: originId }, data: { isActive: true } });
    }
    await t.http().get(`/api/v1${path}`).set('Authorization', `Bearer ${key.key}`).expect(401);
  });
  it('replays exactly the original committed reply after a later update, and recovers it by operation id', async () => {
    const input = capture();
    const idem = randomUUID();
    const first = result(await post(input, idem).expect(201));
    const update = {
      ...input,
      expectedVersion: 1,
      fields: {
        name: { value: 'Explicit sender', source: 'CUSTOMER_STATEMENT', messageId: 'name-event' },
      },
    };
    const updated = result(
      await call('patch', `/cs/customer-profiles/${first.profileId}`, update).expect(200),
    );
    expect(updated.profileVersion).toBe(2);
    expect(result(await post(input, idem).expect(200))).toEqual(first);
    expect(
      result(
        await call(
          'get',
          `/cs/customer-profile-operations/${first.operationId}`,
          input.sender,
        ).expect(200),
      ),
    ).toEqual(first);
    expect(
      (await t.prisma.customerProfile.findUniqueOrThrow({ where: { id: first.profileId! } })).name,
    ).toBe('Explicit sender');
  });
  it('concurrent requests with different keys for the same identity create only one profile; same key has one operation', async () => {
    const input = capture();
    const responses = await Promise.all([post(input), post(input)]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 201]);
    expect(result(responses[0]).profileId).toBe(result(responses[1]).profileId);
    const again = capture();
    const idem = randomUUID();
    const same = await Promise.all([post(again, idem), post(again, idem)]);
    expect(same.map((r) => r.status).sort()).toEqual([200, 201]);
    expect(same[0].body).toEqual(same[1].body);
  });
  it('two equal names are not merged; changing Telegram username preserves identity', async () => {
    const name = { name: { value: 'Same name', source: 'CUSTOMER_STATEMENT' } };
    const a = capture({ fields: name });
    const b = capture({ fields: name });
    const ar = result(await post(a).expect(201));
    const br = result(await post(b).expect(201));
    expect(ar.profileId).not.toBe(br.profileId);
    const changed = {
      ...a,
      sender: { ...a.sender, username: 'new_username', observedAt: new Date().toISOString() },
    };
    expect(result(await post(changed).expect(200)).profileId).toBe(ar.profileId);
  });
  it.each([false, true])(
    'WhatsApp phone comes from signed sender metadata (explicit evidence %s)',
    async (explicitEvidence) => {
      const phone = uniquePhone();
      const input = capture({
        sender: sender({
          channel: 'WHATSAPP',
          subjectId: phone,
          ...(explicitEvidence ? { phoneEvidence: { kind: 'WHATSAPP_SENDER', value: phone } } : {}),
        }),
      });
      const r = result(await post(input).expect(201));
      expect(
        await t.prisma.customerProfile.findUnique({ where: { id: r.profileId! } }),
      ).toMatchObject({ phone, phoneVerified: true, name: null });
      await post({
        ...input,
        sender: {
          ...input.sender,
          phoneEvidence: { kind: 'WHATSAPP_SENDER', value: '+249900000001' },
        },
      }).expect(400);
    },
  );
  it('Telegram own contact completes the same profile; someone else contact is refused', async () => {
    const input = capture();
    const r = result(await post(input).expect(201));
    const phone = uniquePhone();
    const update = {
      ...input,
      expectedVersion: 1,
      sender: {
        ...input.sender,
        phoneEvidence: {
          kind: 'TELEGRAM_OWN_CONTACT',
          value: phone,
          contactUserId: input.sender.subjectId,
        },
      },
    };
    expect(
      result(await call('patch', `/cs/customer-profiles/${r.profileId}`, update).expect(200))
        .profileId,
    ).toBe(r.profileId);
    await call('patch', `/cs/customer-profiles/${r.profileId}`, {
      ...update,
      sender: {
        ...update.sender,
        phoneEvidence: { ...update.sender.phoneEvidence, contactUserId: '999' },
      },
    }).expect(400);
  });
  it('a conflicting value is a proposal, not a destructive last-write-wins update; stale version and null cannot erase', async () => {
    const input = capture({
      fields: { name: { value: 'Original', source: 'CUSTOMER_STATEMENT' } },
    });
    const r = result(await post(input).expect(201));
    const update = {
      ...input,
      expectedVersion: 1,
      fields: { name: { value: 'Replacement', source: 'CUSTOMER_STATEMENT' } },
    };
    const proposal = result(
      await call('patch', `/cs/customer-profiles/${r.profileId}`, update).expect(200),
    );
    expect(proposal.outcome).toBe('NEEDS_REVIEW');
    expect(proposal.profileVersion).toBe(2);
    expect(
      (await t.prisma.customerProfile.findUniqueOrThrow({ where: { id: r.profileId! } })).name,
    ).toBe('Original');
    expect(
      (await call('patch', `/cs/customer-profiles/${r.profileId}`, update).expect(409)).body,
    ).toMatchObject({ code: 'VERSION_CONFLICT', currentVersion: 2 });
    const cleared = {
      ...update,
      expectedVersion: 2,
      fields: { name: { value: null, source: 'CUSTOMER_STATEMENT' } },
    };
    expect(
      result(await call('patch', `/cs/customer-profiles/${r.profileId}`, cleared).expect(200))
        .profileVersion,
    ).toBe(2);
  });
  it('phone matches need review without exposing or linking another customer; scope is separate from transaction reads', async () => {
    const phone = uniquePhone();
    const a = capture({ fields: { phone: { value: phone, source: 'CUSTOMER_STATEMENT' } } });
    const ar = result(await post(a).expect(201));
    const b = capture({ fields: a.fields });
    const br = result(await post(b).expect(200));
    expect(br.outcome).toBe('NEEDS_REVIEW');
    expect(br.profileId).toBeNull();
    expect(result(await post({ ...b, fields: {} }).expect(200))).toMatchObject({
      outcome: 'NEEDS_REVIEW',
      profileId: null,
    });
    expect(JSON.stringify(br)).not.toContain(ar.profileId!);
    await t
      .http()
      .get('/api/v1/cs/customers?phone=' + encodeURIComponent(phone))
      .set('Authorization', `Bearer ${key.key}`)
      .expect(403);
    await t
      .http()
      .get('/api/v1/cs/me/shipments')
      .set('Authorization', `Bearer ${key.key}`)
      .expect(401);
  });
  it('different content cannot reuse an idempotency key; conversations cannot change their sender', async () => {
    const input = capture();
    const idem = randomUUID();
    await post(input, idem).expect(201);
    expect(
      (
        await post(
          { ...input, fields: { name: { value: 'Changed', source: 'CUSTOMER_STATEMENT' } } },
          idem,
        ).expect(409)
      ).body as { code: string },
    ).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(
      (await post({ ...input, sender: sender() }).expect(409)).body as { code: string },
    ).toMatchObject({ code: 'CONVERSATION_IDENTITY_CONFLICT' });
  });
  it('wrong sender/key cannot recover a result or update a guessed profile; old operation is not re-executed', async () => {
    const input = capture();
    const idem = randomUUID();
    const r = result(await post(input, idem).expect(201));
    await call('get', `/cs/customer-profile-operations/${r.operationId}`, sender()).expect(404);
    await call(
      'get',
      `/cs/customer-profile-operations/${r.operationId}`,
      input.sender,
      randomUUID(),
      otherId,
      otherKey.key,
    ).expect(404);
    await call('patch', `/cs/customer-profiles/${r.profileId}`, {
      ...capture(),
      expectedVersion: 1,
    }).expect(404);
    const realNow = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(realNow + 91 * 86400000);
    try {
      expect((await post(input, idem).expect(410)).body as { code: string }).toMatchObject({
        code: 'OPERATION_RESULT_EXPIRED',
      });
      const live = await call(
        'get',
        `/cs/customer-profiles/self?conversationId=${input.conversationId}`,
        {},
        '',
        clientId,
        key.key,
        input.sender,
      ).expect(200);
      expect(live.body as unknown).toMatchObject({
        profileId: r.profileId,
        profileVersion: r.profileVersion,
      });
    } finally {
      clock.mockRestore();
    }
  });

  it('staff identity discovery is explicitly granted, not inherited with ordinary customer access', async () => {
    const r = result(await post(capture()).expect(201));
    await t
      .http()
      .get(`/api/v1/customer-profiles/${r.profileId}`)
      .set('Cookie', ordinaryCookie)
      .expect(403);
    const read = await t
      .http()
      .get(`/api/v1/customer-profiles/${r.profileId}`)
      .set('Cookie', staffCookie)
      .expect(200);
    expect(read.body).toMatchObject({ id: r.profileId, name: null, phone: null });
    expect(read.body).not.toHaveProperty('accounts');
  });
  it('follow-up uses residence rules, requires permanent-move confirmation, and never moves branch accounts', async () => {
    const input = capture();
    const r = result(await post(input).expect(201));
    const putRule = (city: string, branch: string) =>
      t
        .http()
        .put(`/api/v1/customer-profiles/follow-up-rules/${randomUUID()}`)
        .set('Origin', APP_ORIGIN)
        .set('Cookie', staffCookie)
        .send({ expectedVersion: 0, residenceCityId: city, branchId: branch, isActive: true });
    await putRule(originId, dxb).expect(200);
    await putRule(destinationId, jed).expect(200);
    const initial = {
      schemaVersion: input.schemaVersion,
      conversationId: input.conversationId,
      sender: input.sender,
      expectedVersion: 1,
      residenceCityId: originId,
      intent: 'INITIAL_ASSIGNMENT',
    };
    const first = result(
      await call('post', `/cs/customer-profiles/${r.profileId}/follow-up`, initial).expect(200),
    );
    expect(first.followUp).toMatchObject({ status: 'ASSIGNED', branchId: dxb });
    await call('post', `/cs/customer-profiles/${r.profileId}/follow-up`, {
      ...initial,
      expectedVersion: first.profileVersion,
      residenceCityId: destinationId,
      intent: 'PERMANENT_MOVE',
    }).expect(400);
    const moved = result(
      await call('post', `/cs/customer-profiles/${r.profileId}/follow-up`, {
        ...initial,
        expectedVersion: first.profileVersion,
        residenceCityId: destinationId,
        intent: 'PERMANENT_MOVE',
        permanentConfirmed: true,
        messageId: 'confirmed-permanent-move',
      }).expect(200),
    );
    expect(moved.followUp.branchId).toBe(jed);
    expect(await t.prisma.customer.count({ where: { profileId: r.profileId } })).toBe(0);
    expect(
      await t.prisma.customerFollowUpHistory.count({ where: { profileId: r.profileId! } }),
    ).toBe(2);
    // A historical residence becoming inactive must not prevent unrelated profile completion.
    await t.prisma.location.update({ where: { id: destinationId }, data: { isActive: false } });
    try {
      const updated = result(
        await call('patch', `/cs/customer-profiles/${r.profileId}`, {
          schemaVersion: input.schemaVersion,
          conversationId: input.conversationId,
          sender: input.sender,
          expectedVersion: moved.profileVersion,
          fields: {
            residenceCityId: { value: destinationId, source: 'CUSTOMER_STATEMENT' },
            address: { value: 'Explicit new address', source: 'CUSTOMER_STATEMENT' },
          },
        }).expect(200),
      );
      expect(updated.outcome).toBe('UPDATED');
    } finally {
      await t.prisma.location.update({ where: { id: destinationId }, data: { isActive: true } });
    }
    await putRule(destinationId, dxb).expect(200);
    const latest = await t.prisma.customerProfile.findUniqueOrThrow({
      where: { id: r.profileId! },
    });
    const ambiguous = result(
      await call('post', `/cs/customer-profiles/${r.profileId}/follow-up`, {
        ...initial,
        expectedVersion: latest.version,
        residenceCityId: destinationId,
        intent: 'PERMANENT_MOVE',
        permanentConfirmed: true,
        messageId: 'confirmed-move-with-ambiguous-routing',
      }).expect(200),
    );
    expect(ambiguous.followUp).toEqual({
      status: 'NEEDS_REVIEW',
      branchId: jed,
      reason: 'SEVERAL_RULES',
    });
    const live = await call(
      'get',
      `/cs/customer-profiles/self?conversationId=${input.conversationId}`,
      {},
      '',
      clientId,
      key.key,
      input.sender,
    ).expect(200);
    expect((live.body as SelfProfileResult).followUp).toEqual({
      status: 'NEEDS_REVIEW',
      branchId: jed,
      reason: 'REVIEW_REQUIRED',
    });
    expect((live.body as SelfProfileResult).fields.residenceCityId.value).toBe(destinationId);
  });
  it.each([false, true])(
    'signed booking approval without re-entry or invented Telegram phone (unverified contact %s)',
    async (unverifiedContact) => {
      const unverifiedPhone = uniquePhone();
      const input = capture({
        fields: {
          name: { value: 'Explicit booking sender', source: 'CUSTOMER_STATEMENT' },
          ...(unverifiedContact
            ? { phone: { value: unverifiedPhone, source: 'CUSTOMER_STATEMENT' } }
            : {}),
        },
      });
      const r = result(await post(input).expect(201));
      const request = {
        ...bookingExamples.ids.body,
        profileId: r.profileId,
        conversationId: input.conversationId,
        sender: { channel: 'telegram', id: input.sender.subjectId },
        originId,
        destinationId,
        category,
        quantity: '2',
        services: [],
        senderName: 'Explicit booking sender',
        consigneeName: 'Receiver, not sender',
        consigneePhone: '0912345678',
        handover: 'BRANCH_DROP',
        language: 'ar',
        idempotencyKey: randomUUID(),
      };
      await call(
        'post',
        '/cs/booking-requests',
        { ...request, profileId: randomUUID() },
        randomUUID(),
        clientId,
        key.key,
        input.sender,
      ).expect(404);
      const made = await call(
        'post',
        '/cs/booking-requests',
        request,
        request.idempotencyKey,
        clientId,
        key.key,
        input.sender,
      ).expect(201);
      const requestId = (made.body as { requestId: string }).requestId;
      expect(made.body as unknown).toMatchObject(bookingExamples.ids.response);
      expect(Object.keys(made.body as object).sort()).toEqual(['reference', 'requestId', 'status']);
      const detail = await t
        .http()
        .get(`/api/v1/cs-booking-requests/${requestId}`)
        .set('Cookie', staffCookie)
        .expect(200);
      expect((detail.body as { profile: unknown }).profile).toMatchObject({
        id: r.profileId,
        name: 'Explicit booking sender',
        phone: unverifiedContact ? unverifiedPhone : null,
        phoneVerified: false,
      });
      const pricing = {
        originId,
        destinationId,
        mode: 'ROAD',
        category,
        quantity: '2',
        currency: 'USD',
      };
      const price = await t
        .http()
        .get(`/api/v1/cs-booking-requests/${requestId}/price`)
        .query(pricing)
        .set('Cookie', staffCookie)
        .expect(200);
      const approve = (extra: object = {}) =>
        t
          .http()
          .post(`/api/v1/cs-booking-requests/${requestId}/approve`)
          .set('Origin', APP_ORIGIN)
          .set('Cookie', staffCookie)
          .send({
            version: (detail.body as { version: number }).version,
            profileVersion: r.profileVersion,
            pricing,
            pricingFingerprint: (price.body as { pricingFingerprint: string | null })
              .pricingFingerprint,
            paymentCurrency: 'USD',
            booking: { services: [] },
            ...extra,
          });
      await approve({ profileVersion: 999 }).expect(409);
      expect(await t.prisma.customer.count({ where: { profileId: r.profileId } })).toBe(0);
      await approve().expect(201);
      const accounts = await t.prisma.customer.findMany({ where: { profileId: r.profileId } });
      expect(accounts).toHaveLength(1);
      expect(accounts[0]).toMatchObject({
        phone: null,
        branchId: dxb,
        name: 'Explicit booking sender',
      });
      const approvedRequest = await t.prisma.csBookingRequest.findUniqueOrThrow({
        where: { id: requestId },
      });
      expect(approvedRequest.customerId).toBeNull(); // owner stays the channel, never a fabricated read grant.
      expect(
        (await t.prisma.booking.findUniqueOrThrow({ where: { id: approvedRequest.bookingId! } }))
          .customerId,
      ).toBe(accounts[0]!.id);
      await approve().expect(409);
      expect(await t.prisma.customer.count({ where: { profileId: r.profileId } })).toBe(1);
      if (unverifiedContact) {
        await t.prisma.apiClientScope.upsert({
          where: { apiClientId_scope: { apiClientId: clientId, scope: 'CUSTOMER_TOKENS_ISSUE' } },
          create: { apiClientId: clientId, scope: 'CUSTOMER_TOKENS_ISSUE', grantedById: creatorId },
          update: {},
        });
        const token = await t
          .http()
          .post('/api/v1/cs/customer-tokens')
          .set('Authorization', `Bearer ${key.key}`)
          .send({ phone: unverifiedPhone })
          .expect(200);
        expect(token.body as unknown).toEqual({ kind: 'none' });
      }
    },
  );
  it('phone-less by-names Telegram booking uses the signed stable id, not tel: or recipient phone', async () => {
    const input = capture();
    const r = result(await post(input).expect(201));
    const request = {
      ...bookingExamples.names.body,
      profileId: r.profileId,
      conversationId: input.conversationId,
      channel: 'telegram',
      origin: { ar: 'غير معروف', en: 'Unknown' },
      destination: { ar: 'غير معروف', en: 'Unknown' },
      kind: { ar: category, en: category },
      quantity: '1',
      senderName: 'Explicit sender',
      receiverName: 'Receiver',
      receiverPhone: '0912345678',
      handover: 'dropoff',
      idempotencyKey: randomUUID(),
    };
    const made = await call(
      'post',
      '/cs/booking-requests',
      request,
      request.idempotencyKey,
      clientId,
      key.key,
      input.sender,
    ).expect(201);
    expect(made.body as unknown).toMatchObject(bookingExamples.names.response);
    expect(Object.keys(made.body as object).sort()).toEqual(['reference', 'requestId', 'status']);
    const row = await t.prisma.csBookingRequest.findUniqueOrThrow({
      where: { id: (made.body as { requestId: string }).requestId },
    });
    expect(row).toMatchObject({
      profileId: r.profileId,
      senderId: input.sender.subjectId,
      contactPhone: null,
      customerId: null,
    });
  });
  it('legacy matching remains pending until an explicitly authorised human proves the link', async () => {
    const phone = uniquePhone();
    const old = await t.prisma.customer.create({
      data: {
        number: `OLD${randomUUID().slice(0, 12)}`,
        branchId: dxb,
        name: 'Existing customer',
        phone,
        kind: 'INDIVIDUAL',
        createdById: creatorId,
      },
    });
    const input = capture({ fields: { phone: { value: phone, source: 'CUSTOMER_STATEMENT' } } });
    const r = result(await post(input).expect(200));
    expect(r.profileId).toBeNull();
    const identity = await t.prisma.customerChannelIdentity.findUniqueOrThrow({
      where: {
        companyId_channel_subjectId: {
          companyId,
          channel: 'TELEGRAM',
          subjectId: input.sender.subjectId,
        },
      },
    });
    const body = {
      accountId: old.id,
      proofNote: 'Customer ownership verified by an authorised human',
    };
    await t
      .http()
      .post(`/api/v1/customer-profiles/intake/${identity.id}/resolve`)
      .set('Origin', APP_ORIGIN)
      .set('Cookie', ordinaryCookie)
      .send(body)
      .expect(403);
    await t
      .http()
      .post(`/api/v1/customer-profiles/intake/${identity.id}/resolve`)
      .set('Origin', APP_ORIGIN)
      .set('Cookie', staffCookie)
      .send(body)
      .expect(201);
    // Legacy branch-local accounts may share a phone. A proved existing link is not a new claim.
    await t.prisma.customer.create({
      data: {
        number: `OLD${randomUUID().slice(0, 12)}`,
        branchId: jed,
        name: 'Other legacy branch account',
        phone,
        kind: 'INDIVIDUAL',
        createdById: creatorId,
      },
    });
    const restored = result(await post(input).expect(200));
    expect(restored.outcome).toBe('RESTORED');
    expect((await t.prisma.customer.findUniqueOrThrow({ where: { id: old.id } })).profileId).toBe(
      restored.profileId,
    );
    expect(
      await t.prisma.customerProfileReview.count({
        where: { entityId: identity.id, action: 'IDENTITY_LINK' },
      }),
    ).toBe(1);
  });
  it('backfill is explicit, resumable, preserves account ids/numbers, and never links a channel by name or phone', async () => {
    const before = await t.prisma.customer.findMany({
      where: { profileId: null },
      select: { id: true, number: true, branchId: true },
    });
    const dry = await backfillCustomerProfiles(t.prisma, companyId, false);
    expect(dry.linked).toBe(0);
    await backfillCustomerProfiles(t.prisma, companyId, true, 1000);
    expect((await backfillCustomerProfiles(t.prisma, companyId, true, 1000)).linked).toBe(0);
    for (const row of before) {
      const after = await t.prisma.customer.findUniqueOrThrow({ where: { id: row.id } });
      expect(after).toMatchObject(row);
      expect(after.profileId).not.toBeNull();
      expect(
        await t.prisma.customerChannelIdentity.count({ where: { profileId: after.profileId } }),
      ).toBe(0);
    }
  });
  it('scope revocation between guard and write is rechecked; shared quotas do not count replay', async () => {
    const service = t.app.get(CustomerIdentityService);
    const original = service.requireKey.bind(service);
    const spy = vi.spyOn(service, 'requireKey').mockImplementationOnce(async (tx, client) => {
      await t.prisma.apiClient.update({ where: { id: client }, data: { isActive: false } });
      return original(tx, client);
    });
    try {
      await post(capture()).expect(403);
    } finally {
      spy.mockRestore();
      await t.prisma.apiClient.update({ where: { id: clientId }, data: { isActive: true } });
    }
    const input = capture();
    const idem = randomUUID();
    await post(input, idem).expect(201);
    for (let i = 0; i < 9; i++) await post(input).expect(200);
    await post(input, idem).expect(200);
    const limited = await post(input).expect(429);
    expect(limited.headers['retry-after']).toBe('3600');
  });

  it('disputed fields stay pending across restores until a version-bound human rejection; history cannot be edited', async () => {
    const input = capture({
      fields: { name: { value: 'Original explicit name', source: 'CUSTOMER_STATEMENT' } },
    });
    const first = result(await post(input).expect(201));
    const proposal = {
      ...input,
      expectedVersion: 1,
      fields: { name: { value: 'Disputed receiver name', source: 'CUSTOMER_STATEMENT' } },
    };
    const pending = result(
      await call('patch', `/cs/customer-profiles/${first.profileId}`, proposal).expect(200),
    );
    expect(result(await post({ ...input, fields: {} }).expect(200)).outcome).toBe('NEEDS_REVIEW');
    const resolve = (cookie: string, version: number) =>
      t
        .http()
        .post(`/api/v1/customer-profiles/${first.profileId}/reject-proposals`)
        .set('Origin', APP_ORIGIN)
        .set('Cookie', cookie)
        .send({
          expectedVersion: version,
          proofNote:
            'Human confirmed the existing sender name and rejected the disputed receiver name',
        });
    await resolve(ordinaryCookie, pending.profileVersion!).expect(403);
    await resolve(staffCookie, 1).expect(409);
    await resolve(staffCookie, pending.profileVersion!).expect(201);
    expect(result(await post({ ...input, fields: {} }).expect(200)).outcome).toBe('RESTORED');
    expect(
      (await t.prisma.customerProfile.findUniqueOrThrow({ where: { id: first.profileId! } })).name,
    ).toBe('Original explicit name');
    await expect(
      t.prisma.customerProfileOperation.update({
        where: { id: first.operationId },
        data: { result: {} },
      }),
    ).rejects.toThrow();
    await expect(
      t.prisma.customerProfileEvidence.deleteMany({ where: { operationId: first.operationId } }),
    ).rejects.toThrow();
    const binding = await t.prisma.customerProfileConversation.findFirstOrThrow({
      where: { companyId, conversationId: input.conversationId },
    });
    await expect(
      t.prisma.customerProfileConversation.update({
        where: { id: binding.id },
        data: { conversationId: 'reassigned' },
      }),
    ).rejects.toThrow();
  });
  it('cannot bind or read another company profile even when its identifier is known', async () => {
    const input = capture();
    await post(input).expect(201);
    const foreign = await t.prisma.customerProfile.create({
      data: {
        companyId: `other-${randomUUID()}`,
        number: `CP${randomUUID().slice(0, 8)}`,
        name: 'Other company',
      },
    });
    await call('patch', `/cs/customer-profiles/${foreign.id}`, {
      ...input,
      expectedVersion: 1,
      fields: { name: { value: 'Changed', source: 'CUSTOMER_STATEMENT' } },
    }).expect(404);
    await t
      .http()
      .get(`/api/v1/customer-profiles/${foreign.id}`)
      .set('Cookie', staffCookie)
      .expect(404);
    expect(
      (await t.prisma.customerProfile.findUniqueOrThrow({ where: { id: foreign.id } })).name,
    ).toBe('Other company');
  });
  describe('GET customer-profiles/self', () => {
    const path = (conversationId: string) =>
      `/cs/customer-profiles/self?conversationId=${encodeURIComponent(conversationId)}`;
    const read = (input: Body, client = clientId, token = key.key) =>
      call('get', path(input.conversationId), {}, '', client, token, input.sender);
    const current = (response: { body: unknown }) => response.body as SelfProfileResult;

    it('reads the current anonymous Telegram profile without a phone, writes nothing, and forbids caching', async () => {
      const input = capture();
      const made = result(await post(input).expect(201));
      const before = await t.prisma.customerProfileOperation.count({ where: { companyId } });
      const response = await read(input).expect(200);
      const fixture = JSON.parse(
        readFileSync(
          new URL('../../../docs/plans/08d-customer-profile-self-examples.json', import.meta.url),
          'utf8',
        ),
      ) as { emptyProfile: SelfProfileResult };
      expect(current(response)).toEqual({ ...fixture.emptyProfile, profileId: made.profileId });
      expect(response.headers['cache-control']).toBe('no-store');
      expect(await t.prisma.customerProfileOperation.count({ where: { companyId } })).toBe(before);
      expect(Object.keys(response.body as object).sort()).toEqual(
        [
          'schemaVersion',
          'profileId',
          'profileVersion',
          'fields',
          'missing',
          'needsReview',
          'followUp',
        ].sort(),
      );
      await t
        .http()
        .get('/api/v1/cs/customers?phone=%2B249900000001')
        .set('Authorization', `Bearer ${key.key}`)
        .expect(403);
    });

    it('reads newly accepted values instead of an earlier operation result; proposals never replace them', async () => {
      const input = capture({
        fields: { name: { value: 'Accepted sender', source: 'CUSTOMER_STATEMENT' } },
      });
      const made = result(await post(input).expect(201));
      const patched = result(
        await call('patch', `/cs/customer-profiles/${made.profileId}`, {
          ...input,
          expectedVersion: made.profileVersion,
          fields: { address: { value: 'Explicit address', source: 'CUSTOMER_STATEMENT' } },
        }).expect(200),
      );
      const proposed = result(
        await call('patch', `/cs/customer-profiles/${made.profileId}`, {
          ...input,
          expectedVersion: patched.profileVersion,
          fields: { name: { value: 'Rejected candidate name', source: 'CUSTOMER_STATEMENT' } },
        }).expect(200),
      );
      const view = current(await read(input).expect(200));
      expect(view.profileVersion).toBe(proposed.profileVersion);
      expect(view.needsReview).toBe(true);
      expect(view.fields.name).toEqual({
        value: 'Accepted sender',
        source: 'CUSTOMER_STATEMENT',
        verification: 'UNVERIFIED',
        observedAt: input.sender.observedAt,
      });
      expect(view.fields.address.value).toBe('Explicit address');
      expect(JSON.stringify(view)).not.toContain('Rejected candidate name');
      await t
        .http()
        .post(`/api/v1/customer-profiles/${made.profileId}/reject-proposals`)
        .set('Cookie', staffCookie)
        .set('Origin', APP_ORIGIN)
        .send({
          expectedVersion: proposed.profileVersion,
          proofNote: 'Authorised staff rejected the proposed receiver name',
        })
        .expect(201);
      const after = current(await read(input).expect(200));
      expect(after.needsReview).toBe(false);
      expect(after.profileVersion).toBe(proposed.profileVersion! + 1);
    });

    it('shows a corrected current value without borrowing provenance from the old value', async () => {
      const input = capture({
        fields: { name: { value: 'Before correction', source: 'CUSTOMER_STATEMENT' } },
      });
      const made = result(await post(input).expect(201));
      // Simulate the committed profile write of an authorised staff correction, not a new public edit API.
      await t.prisma.$transaction(async (tx) => {
        await tx.customerProfile.update({
          where: { id: made.profileId! },
          data: { name: 'Corrected by staff', version: { increment: 1 } },
        });
        await tx.customerProfileReview.create({
          data: {
            companyId,
            actorId: creatorId,
            entityId: made.profileId!,
            action: 'PROFILE_CORRECTION',
            reason: 'Synthetic authorised correction fixture',
            snapshot: { field: 'name' },
          },
        });
      });
      const view = current(await read(input).expect(200));
      expect(view.profileVersion).toBe(made.profileVersion! + 1);
      expect(view.fields.name).toEqual({
        value: 'Corrected by staff',
        source: 'UNRECORDED',
        verification: 'UNKNOWN',
        observedAt: null,
      });
    });

    it('only labels the current matching channel-proved phone as verified', async () => {
      const input = capture({ sender: sender({ channel: 'WHATSAPP', subjectId: uniquePhone() }) });
      const made = result(await post(input).expect(201));
      expect(current(await read(input).expect(200)).fields.phone).toEqual({
        value: input.sender.subjectId,
        source: 'WHATSAPP_SENDER',
        verification: 'CHANNEL_VERIFIED',
        observedAt: input.sender.observedAt,
      });
      await t.prisma.customerProfile.update({
        where: { id: made.profileId! },
        data: { phone: uniquePhone(), version: { increment: 1 } },
      });
      expect(current(await read(input).expect(200)).fields.phone.verification).toBe('UNKNOWN');
    });

    it('requires the same sender, key and previously bound conversation, and rejects model selectors', async () => {
      const input = capture();
      await post(input).expect(201);
      await read({ ...input, sender: sender() }).expect(404);
      await read({ ...input, conversationId: randomUUID() }).expect(404);
      await read(input, otherId, otherKey.key).expect(404);
      await call(
        'get',
        path(input.conversationId) + '&profileId=' + randomUUID(),
        {},
        '',
        clientId,
        key.key,
        input.sender,
      ).expect(400);
      await t
        .http()
        .get('/api/v1' + path(input.conversationId))
        .set('Authorization', `Bearer ${key.key}`)
        .expect(401);
      const identity = await t.prisma.customerChannelIdentity.findFirstOrThrow({
        where: { companyId, subjectId: input.sender.subjectId },
      });
      await t.prisma.customerChannelIdentity.update({
        where: { id: identity.id },
        data: { blocked: true },
      });
      await read(input).expect(404);
    });

    it('ignores a same-key conversation in another company and never creates or binds on GET', async () => {
      const input = capture();
      const foreignCompany = `other-${randomUUID()}`;
      const foreignProfile = await t.prisma.customerProfile.create({
        data: {
          companyId: foreignCompany,
          number: `CP${randomUUID().slice(0, 8)}`,
          name: 'Other company customer',
        },
      });
      const foreign = await t.prisma.customerChannelIdentity.create({
        data: {
          companyId: foreignCompany,
          channel: 'TELEGRAM',
          subjectId: input.sender.subjectId,
          observedAt: new Date(),
          profileId: foreignProfile.id,
        },
      });
      await t.prisma.customerProfileConversation.create({
        data: {
          companyId: foreignCompany,
          apiClientId: clientId,
          conversationId: input.conversationId,
          identityId: foreign.id,
        },
      });
      await read(input).expect(404);
      expect(
        await t.prisma.customerChannelIdentity.count({
          where: { companyId, subjectId: input.sender.subjectId },
        }),
      ).toBe(0);
    });

    it('returns an opaque review error for ambiguous identities without candidates or pending input', async () => {
      const phone = uniquePhone();
      await post(
        capture({ fields: { phone: { value: phone, source: 'CUSTOMER_STATEMENT' } } }),
      ).expect(201);
      const input = capture({ fields: { phone: { value: phone, source: 'CUSTOMER_STATEMENT' } } });
      expect(result(await post(input).expect(200)).profileId).toBeNull();
      const response = await read(input).expect(409);
      expect(response.body as unknown).toEqual({
        statusCode: 409,
        code: 'IDENTITY_REVIEW_REQUIRED',
        message: 'IDENTITY_REVIEW_REQUIRED',
      });
    });

    it.each(['scope', 'key'] as const)(
      'rechecks revoked %s after the guard and before returning personal data',
      async (revoked) => {
        const input = capture();
        await post(input).expect(201);
        const service = t.app.get(CustomerIdentityService);
        const original = service.requireKey.bind(service);
        const spy = vi.spyOn(service, 'requireKey').mockImplementationOnce(async (tx, id) => {
          if (revoked === 'key')
            await t.prisma.apiClient.update({ where: { id }, data: { isActive: false } });
          else
            await t.prisma.apiClientScope.deleteMany({
              where: { apiClientId: id, scope: 'CUSTOMER_PROFILES_WRITE' },
            });
          return original(tx, id);
        });
        try {
          await read(input).expect(403);
        } finally {
          spy.mockRestore();
          await t.prisma.apiClient.update({ where: { id: clientId }, data: { isActive: true } });
          await t.prisma.apiClientScope.upsert({
            where: {
              apiClientId_scope: { apiClientId: clientId, scope: 'CUSTOMER_PROFILES_WRITE' },
            },
            create: {
              apiClientId: clientId,
              scope: 'CUSTOMER_PROFILES_WRITE',
              grantedById: creatorId,
            },
            update: {},
          });
        }
      },
    );
  });

  it('unsigned or mutated transport is refused; profile scope is opt-in', async () => {
    await t
      .http()
      .post('/api/v1/cs/customer-profiles/capture')
      .set('Authorization', `Bearer ${key.key}`)
      .set('Idempotency-Key', randomUUID())
      .send(capture())
      .expect(401);
    const input = capture();
    await call('post', '/cs/customer-profiles/capture', input)
      .set('X-Nolon-Channel-Context', Buffer.from(JSON.stringify(sender())).toString('base64url'))
      .expect(401);
    await t.prisma.apiClientScope.deleteMany({ where: { apiClientId: otherId } });
    await call(
      'post',
      '/cs/customer-profiles/capture',
      capture(),
      randomUUID(),
      otherId,
      otherKey.key,
    ).expect(403);
  });
});
