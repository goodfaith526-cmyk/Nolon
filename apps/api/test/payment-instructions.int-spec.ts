import { randomInt, randomUUID } from 'node:crypto';
import type {
  ApiClientCreatedDto,
  CsBookingRequestCreated,
  CsBookingRequestDto,
  PaymentInstructionDto,
} from '@nolon/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  APP_ORIGIN,
  LEDGER_PREFIX,
  type TestApp,
  branchId,
  createTestApp,
  createUser,
  signIn,
} from './auth-test-app.js';
import { uniquePhone } from './test-data.js';

/**
 * Payment instructions (plan 04 section 4.1): a draft per branch and currency, approved by another
 * person than its maker, one approved per branch and currency, an approved text only retired; the
 * bot reads exactly the approved one of an approved request's branch and payment currency. Negative
 * cases: a missing permission, another branch, the maker approving, a stale version, editing an
 * approved text (through the API and in the database), two approved at once, and the bot reading
 * another currency, a retired text or an undecided request.
 */
describe('Payment instructions (R3c3)', () => {
  let t: TestApp;
  let jed = '';
  let pts = '';
  let code = '';
  let other = '';
  const cookies = { admin: '', finance: '', manager: '', managerPts: '', sales: '' };
  let financeId = '';

  const staff = (cookie: string) => ({
    get: (path: string, query: object = {}) =>
      t.http().get(`/api/v1${path}`).query(query).set('Cookie', cookie),
    post: (path: string, body: object) =>
      t.http().post(`/api/v1${path}`).set('Origin', APP_ORIGIN).set('Cookie', cookie).send(body),
    patch: (path: string, body: object) =>
      t.http().patch(`/api/v1${path}`).set('Origin', APP_ORIGIN).set('Cookie', cookie).send(body),
  });
  const draft = async (cookie: string, currency = code, branch = jed, text = 'Pay to account 1') =>
    (
      await staff(cookie)
        .post('/payment-instructions', {
          branchId: branch,
          currency,
          textAr: `ادفع: ${text}`,
          textEn: text,
        })
        .expect(201)
    ).body as PaymentInstructionDto;
  const approved = () =>
    t.prisma.paymentInstruction.findMany({
      where: { branchId: jed, currency: code, status: 'APPROVED' },
    });

  const newCurrency = async () => {
    const c = `Q${String.fromCharCode(65 + randomInt(26))}${String.fromCharCode(65 + randomInt(26))}`;
    await t.prisma.currency.upsert({
      where: { code: c },
      create: { code: c, nameEn: `Test ${c}`, nameAr: `تجربة ${c}`, decimalPlaces: 2 },
      update: { isActive: true },
    });
    return c;
  };

  beforeAll(async () => {
    t = await createTestApp();
    jed = await branchId(t.prisma, 'JED');
    pts = await branchId(t.prisma, 'PTS');
    const user = async (roles: Parameters<typeof createUser>[1], branches: string[]) =>
      createUser(t.prisma, roles, branches, LEDGER_PREFIX);
    cookies.admin = await signIn(t, (await user(['ADMINISTRATOR'], [])).email);
    const finance = await user(['FINANCE'], ['JED']);
    financeId = finance.id;
    cookies.finance = await signIn(t, finance.email);
    cookies.manager = await signIn(t, (await user(['BRANCH_MANAGER'], ['JED'])).email);
    cookies.managerPts = await signIn(t, (await user(['BRANCH_MANAGER'], ['PTS'])).email);
    cookies.sales = await signIn(t, (await user(['SALES'], ['JED'])).email);
    // Fresh currencies: earlier runs leave their rows in JED.
    code = await newCurrency();
    do other = await newCurrency();
    while (other === code);
  });

  afterAll(async () => {
    await t.close();
  });

  it('writes drafts in the person’s own branches only, with the permission', async () => {
    const made = await draft(cookies.finance);
    expect(made).toMatchObject({
      branchId: jed,
      branchCode: 'JED',
      currency: code,
      status: 'DRAFT',
      version: 1,
      createdById: financeId,
      // Finance writes drafts; approving and retiring are others' (the matrix).
      actions: { canEdit: true, canApprove: false, canRetire: false },
    });
    const body = { branchId: pts, currency: code, textAr: 'نص', textEn: 'Text' };
    await staff(cookies.finance).post('/payment-instructions', body).expect(403);
    await staff(cookies.sales)
      .post('/payment-instructions', { ...body, branchId: jed })
      .expect(403);
    await staff(cookies.finance)
      .post('/payment-instructions', { ...body, branchId: jed, currency: 'XQZ' })
      .expect(400);
    await staff(cookies.finance)
      .post('/payment-instructions', { ...body, branchId: jed, extra: true })
      .expect(400);

    // Read in its branch only; the manager may approve it, its maker may not.
    expect(
      (
        (await staff(cookies.sales).get(`/payment-instructions/${made.id}`).expect(200))
          .body as PaymentInstructionDto
      ).actions,
    ).toEqual({ canEdit: false, canApprove: false, canRetire: false });
    await staff(cookies.managerPts).get(`/payment-instructions/${made.id}`).expect(404);
    const listed = (await staff(cookies.managerPts).get('/payment-instructions').expect(200))
      .body as PaymentInstructionDto[];
    expect(listed.some((r) => r.id === made.id)).toBe(false);
    expect(
      (
        (await staff(cookies.manager).get(`/payment-instructions/${made.id}`).expect(200))
          .body as PaymentInstructionDto
      ).actions.canApprove,
    ).toBe(true);

    // A draft is edited at the version its editor saw.
    const edited = (
      await staff(cookies.finance)
        .patch(`/payment-instructions/${made.id}`, {
          version: 1,
          textAr: 'ادفع للحساب 2',
          textEn: 'Pay to account 2',
        })
        .expect(200)
    ).body as PaymentInstructionDto;
    expect(edited).toMatchObject({ version: 2, textEn: 'Pay to account 2' });
    await staff(cookies.finance)
      .patch(`/payment-instructions/${made.id}`, { version: 1, textAr: 'x', textEn: 'x' })
      .expect(409);
    const logged = await t.prisma.auditEvent.findMany({
      where: { entity: 'PAYMENT_INSTRUCTION', entityId: made.id },
      orderBy: { occurredAt: 'asc' },
    });
    expect(logged.map((e) => e.action)).toEqual(['CREATED', 'UPDATED']);
  });

  it('is approved by another person, replaces the approved one, and is then only retired', async () => {
    const first = await draft(cookies.finance, code, jed, 'First');
    // Its maker may not approve it, even holding the permission.
    const own = await draft(cookies.admin, code, jed, 'Own');
    const refused = await staff(cookies.admin)
      .post(`/payment-instructions/${own.id}/approve`, { version: own.version })
      .expect(403);
    expect((refused.body as { code?: string }).code).toBe('SAME_PERSON');
    await staff(cookies.finance)
      .post(`/payment-instructions/${first.id}/approve`, { version: first.version })
      .expect(403);
    await staff(cookies.managerPts)
      .post(`/payment-instructions/${first.id}/approve`, { version: first.version })
      .expect(404);
    await staff(cookies.manager)
      .post(`/payment-instructions/${first.id}/approve`, { version: first.version + 1 })
      .expect(409);

    // F140-1: whoever rewrote the text may not approve it, though another person made the draft.
    const rewritten = (
      await staff(cookies.manager)
        .patch(`/payment-instructions/${first.id}`, {
          version: first.version,
          textAr: 'ادفع لحساب المدير',
          textEn: "Pay to the manager's account",
        })
        .expect(200)
    ).body as PaymentInstructionDto;
    expect(rewritten.editedByName).not.toBeNull();
    expect(rewritten.actions.canApprove).toBe(false);
    const own2 = await staff(cookies.manager)
      .post(`/payment-instructions/${first.id}/approve`, { version: rewritten.version })
      .expect(403);
    expect((own2.body as { code?: string }).code).toBe('SAME_PERSON');
    // Its maker rewrites it back; then another person approves the text they did not write.
    const back = (
      await staff(cookies.admin)
        .patch(`/payment-instructions/${first.id}`, {
          version: rewritten.version,
          textAr: 'ادفع: First',
          textEn: 'First',
        })
        .expect(200)
    ).body as PaymentInstructionDto;
    const one = (
      await staff(cookies.manager)
        .post(`/payment-instructions/${first.id}/approve`, { version: back.version })
        .expect(201)
    ).body as PaymentInstructionDto;
    expect(one).toMatchObject({ status: 'APPROVED', version: back.version + 1, textEn: 'First' });
    expect(one.approvedByName).not.toBeNull();
    await staff(cookies.finance)
      .patch(`/payment-instructions/${first.id}`, {
        version: one.version,
        textAr: 'x',
        textEn: 'x',
      })
      .expect(409);

    // A second approval retires the first in the same transaction.
    const second = await draft(cookies.finance, code, jed, 'Second');
    await staff(cookies.manager)
      .post(`/payment-instructions/${second.id}/approve`, { version: second.version })
      .expect(201);
    const now = await approved();
    expect(now.map((r) => r.id)).toEqual([second.id]);
    const retired = await t.prisma.paymentInstruction.findUniqueOrThrow({
      where: { id: first.id },
    });
    expect(retired).toMatchObject({ status: 'RETIRED', version: one.version + 1 });
    expect(retired.retiredAt).not.toBeNull();
    // A retired text is decided: neither approved again nor retired again.
    await staff(cookies.manager)
      .post(`/payment-instructions/${first.id}/approve`, { version: retired.version })
      .expect(409);
    await staff(cookies.manager)
      .post(`/payment-instructions/${first.id}/retire`, { version: retired.version })
      .expect(409);

    // Two approvals at once of two drafts of one branch and currency: one approved at the end.
    const a = await draft(cookies.finance, code, jed, 'A');
    const b = await draft(cookies.finance, code, jed, 'B');
    const results = await Promise.all(
      [a, b].map((d) =>
        Promise.resolve(
          staff(cookies.manager).post(`/payment-instructions/${d.id}/approve`, {
            version: d.version,
          }),
        ),
      ),
    );
    expect(results.map((r) => r.status)).toEqual([201, 201]);
    const after = await approved();
    expect(after).toHaveLength(1);
    expect([a.id, b.id]).toContain(after[0]!.id);
  });

  it('refuses in the database an edit of an approved text, a second approved one, and a self-approval', async () => {
    const d = await draft(cookies.finance, other, jed, 'Database');
    await staff(cookies.manager)
      .post(`/payment-instructions/${d.id}/approve`, { version: d.version })
      .expect(201);
    await expect(
      t.prisma.paymentInstruction.update({ where: { id: d.id }, data: { textEn: 'Changed' } }),
    ).rejects.toThrow();
    await expect(t.prisma.paymentInstruction.delete({ where: { id: d.id } })).rejects.toThrow();
    const approver = (await t.prisma.paymentInstruction.findUniqueOrThrow({ where: { id: d.id } }))
      .approvedById!;
    await expect(
      t.prisma.paymentInstruction.create({
        data: {
          branchId: jed,
          currency: other,
          textAr: 'ثاني',
          textEn: 'Second approved',
          status: 'APPROVED',
          createdById: financeId,
          editedById: financeId,
          approvedById: approver,
          approvedAt: new Date(),
        },
      }),
    ).rejects.toThrow();
    await expect(
      t.prisma.paymentInstruction.create({
        data: {
          branchId: pts,
          currency: other,
          textAr: 'ذاتي',
          textEn: 'Self approved',
          status: 'APPROVED',
          createdById: financeId,
          editedById: financeId,
          approvedById: financeId,
          approvedAt: new Date(),
        },
      }),
    ).rejects.toThrow(/payment_instructions_approval_check/);
    // F140-1: nor by the writer of its current text, whoever made it first.
    await expect(
      t.prisma.paymentInstruction.create({
        data: {
          branchId: pts,
          currency: other,
          textAr: 'محرر',
          textEn: 'Edited and approved',
          status: 'APPROVED',
          createdById: financeId,
          editedById: approver,
          approvedById: approver,
          approvedAt: new Date(),
        },
      }),
    ).rejects.toThrow(/payment_instructions_approval_check/);
  });

  it('shows the bot exactly the approved text of an approved request’s branch and payment currency', async () => {
    const bot = (
      await staff(cookies.admin)
        .post('/api-clients', {
          name: 'Payment instructions',
          branchIds: [jed],
          scopes: ['cs:booking_requests:create'],
        })
        .expect(201)
    ).body as ApiClientCreatedDto;
    const tag = `P${randomUUID().slice(0, 5).toUpperCase()}`;
    const [origin, dest] = await Promise.all(
      ['ORG', 'DES'].map(
        async (suffix) =>
          (
            await t.prisma.location.create({
              data: {
                code: `${tag}${suffix}`,
                kind: 'CITY',
                nameEn: `Pay ${tag}${suffix}`,
                nameAr: 'مكان اختبار الدفع',
                countryCode: 'SA',
              },
            })
          ).id,
      ),
    );
    await t
      .http()
      .put(`/api/v1/master-data/locations/${origin}/routing-branches`)
      .set('Origin', APP_ORIGIN)
      .set('Cookie', cookies.admin)
      .send({ branchIds: [jed] })
      .expect(200);
    const category = (await t.prisma.priceCategory.findFirstOrThrow({ where: { isActive: true } }))
      .code;
    const from = { channel: 'whatsapp', id: uniquePhone() };
    const made = (
      await t
        .http()
        .post('/api/v1/cs/booking-requests')
        .set('Authorization', `Bearer ${bot.key}`)
        .send({
          sender: from,
          originId: origin,
          destinationId: dest,
          category,
          quantity: '1',
          services: [],
          senderName: 'Sender',
          consigneeName: 'Consignee',
          consigneePhone: '0912345678',
          handover: 'PICKUP',
          language: 'ar',
          idempotencyKey: `pay-${randomUUID()}`,
        })
        .expect(201)
    ).body as CsBookingRequestCreated;
    const read = async () =>
      (
        await t
          .http()
          .get(`/api/v1/cs/booking-requests/${made.requestId}`)
          .set('Authorization', `Bearer ${bot.key}`)
          .set('X-Cs-Sender', `whatsapp:${from.id}`)
          .expect(200)
      ).body as CsBookingRequestDto;

    // Undecided: none, whatever is approved.
    expect((await read()).paymentInstructions).toBeNull();
    // Approved in the branch and currency of an approved text: that text, word for word.
    await t.prisma.csBookingRequest.update({
      where: { id: made.requestId },
      data: { status: 'APPROVED', branchId: jed, paymentCurrency: code },
    });
    const [current] = await approved();
    expect((await read()).paymentInstructions).toEqual({
      id: current!.id,
      version: current!.version,
      branchCode: 'JED',
      currency: code,
      textAr: current!.textAr,
      textEn: current!.textEn,
    });
    // Another currency with no approved text of its own in JED: none, never a "nearest" one.
    const lone = await newCurrency();
    await t.prisma.csBookingRequest.update({
      where: { id: made.requestId },
      data: { paymentCurrency: lone },
    });
    expect((await read()).paymentInstructions).toBeNull();
    // Retired: none.
    await t.prisma.csBookingRequest.update({
      where: { id: made.requestId },
      data: { paymentCurrency: code },
    });
    await staff(cookies.finance)
      .post(`/payment-instructions/${current!.id}/retire`, { version: current!.version })
      .expect(403);
    await staff(cookies.manager)
      .post(`/payment-instructions/${current!.id}/retire`, { version: current!.version })
      .expect(201);
    expect((await read()).paymentInstructions).toBeNull();
  });
});
