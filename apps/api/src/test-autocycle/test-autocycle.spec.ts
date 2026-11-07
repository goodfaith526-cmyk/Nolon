import type { CsApprovalPriceDto, CsBookingRequestStaffDto } from '@nolon/shared';
import { describe, expect, it } from 'vitest';
import { verifyPassword } from '../auth/password.js';
import { loadEnv } from '../config/env.js';
import {
  NO_LOGIN_HASH,
  approvalBody,
  approvalPlan,
  autocycleAllowed,
  isTestRequest,
  packagesOf,
  paymentRequestId,
} from './test-autocycle.js';

const DB = { DATABASE_URL: 'postgresql://u:p@localhost:5432/db' };

describe('test autocycle switch', () => {
  it('is off by default, and its delay is 30 s', () => {
    const env = loadEnv({ ...DB });
    expect(env.CS_TEST_AUTOCYCLE_ENABLED).toBe(false);
    expect(env.CS_TEST_AUTOCYCLE_DELAY_S).toBe(30);
    expect(env.DEPLOY_STACK).toBe('local');
    expect(autocycleAllowed(env)).toBe(false);
  });

  it('runs on staging and locally, never on the production stack', () => {
    const on = (extra: Record<string, string>) =>
      autocycleAllowed(loadEnv({ ...DB, CS_TEST_AUTOCYCLE_ENABLED: 'true', ...extra }));
    expect(on({ NODE_ENV: 'production', DEPLOY_STACK: 'staging' })).toBe(true);
    expect(on({ NODE_ENV: 'development' })).toBe(true);
    // Production: NODE_ENV=production without the staging stack, or the production stack itself.
    expect(on({ NODE_ENV: 'production' })).toBe(false);
    expect(on({ NODE_ENV: 'production', DEPLOY_STACK: '' })).toBe(false);
    expect(on({ NODE_ENV: 'production', DEPLOY_STACK: 'production' })).toBe(false);
    expect(on({ NODE_ENV: 'development', DEPLOY_STACK: 'production' })).toBe(false);
  });

  it('refuses a delay outside 0 to 3600 s and an unknown stack', () => {
    expect(() => loadEnv({ ...DB, CS_TEST_AUTOCYCLE_DELAY_S: '-1' })).toThrow();
    expect(() => loadEnv({ ...DB, CS_TEST_AUTOCYCLE_DELAY_S: '3601' })).toThrow();
    expect(() => loadEnv({ ...DB, DEPLOY_STACK: 'prod' })).toThrow();
    expect(loadEnv({ ...DB, CS_TEST_AUTOCYCLE_DELAY_S: '0' }).CS_TEST_AUTOCYCLE_DELAY_S).toBe(0);
  });
});

describe('test requests', () => {
  it('are the ones whose sender name holds «اختبار», any alef', () => {
    expect(isTestRequest({ senderName: 'محمد اختبار ١', otherSenderName: null })).toBe(true);
    expect(isTestRequest({ senderName: 'إختبار أحمد', otherSenderName: null })).toBe(true);
    expect(isTestRequest({ senderName: 'محمد أحمد علي', otherSenderName: null })).toBe(false);
    // The sender is the other person the bot named, when there is one.
    expect(isTestRequest({ senderName: 'اختبار', otherSenderName: 'محمد علي' })).toBe(false);
    expect(isTestRequest({ senderName: 'محمد علي', otherSenderName: 'اختبار ٢' })).toBe(true);
  });

  it('get one package per item, at least one', () => {
    expect(packagesOf(0)).toBe(1);
    expect(packagesOf(3)).toBe(3);
  });

  it('pay with one request id per request, a valid UUID', () => {
    const a = paymentRequestId('7f1c2b9e-0000-4000-8000-000000000001');
    expect(a).toBe(paymentRequestId('7f1c2b9e-0000-4000-8000-000000000001'));
    expect(a).not.toBe(paymentRequestId('7f1c2b9e-0000-4000-8000-000000000002'));
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('users cannot sign in', async () => {
    expect(await verifyPassword('', NO_LOGIN_HASH)).toBe(false);
    expect(await verifyPassword(NO_LOGIN_HASH, NO_LOGIN_HASH)).toBe(false);
  });
});

function request(patch: Partial<CsBookingRequestStaffDto> = {}): CsBookingRequestStaffDto {
  return {
    version: 3,
    status: 'pending',
    branchId: 'b1',
    originId: 'o1',
    destinationId: 'd1',
    priceCheck: null,
    botQuotedPrice: null,
    items: [],
    category: 'BOX',
    quantity: '2',
    profile: undefined,
    customerId: null,
    otherSender: null,
    instantAccount: null,
    dropOffId: null,
    dropOffChoices: [],
    services: ['MAIN_FREIGHT'],
    requestedDate: null,
    ...patch,
  } as unknown as CsBookingRequestStaffDto;
}

const price = { pricingFingerprint: 'f'.repeat(64) } as CsApprovalPriceDto;

describe('the approval, as the form sends it', () => {
  it('prices the one-item shape in the branch currency and makes the customer from the request', () => {
    const r = request();
    const plan = approvalPlan(r, 'SAR');
    if (typeof plan === 'string') throw new Error(plan);
    expect(approvalBody(r, plan, [price])).toEqual({
      version: 3,
      paymentCurrency: 'SAR',
      newCustomerFromRequest: true,
      pricing: {
        originId: 'o1',
        destinationId: 'd1',
        mode: 'SEA',
        currency: 'SAR',
        category: 'BOX',
        quantity: '2',
      },
      pricingFingerprint: price.pricingFingerprint,
      booking: { services: ['MAIN_FREIGHT'], requestedDeparture: null },
    });
  });

  it("takes the quote's mode and currency, one line per item, the profile's customer", () => {
    const r = request({
      priceCheck: { mode: 'SEA_ROAD', currency: 'USD' } as never,
      items: [
        { category: 'BOX', quantity: '1', isOther: false },
        { category: 'BARREL', quantity: '2', isOther: false },
      ] as never,
      profile: { id: 'p', version: 5, name: 'اختبار', needsReview: false } as never,
    });
    const plan = approvalPlan(r, 'SAR');
    if (typeof plan === 'string') throw new Error(plan);
    const body = approvalBody(r, plan, [price, price]);
    expect(body).toMatchObject({
      profileVersion: 5,
      paymentCurrency: 'USD',
      pricing: { mode: 'SEA_ROAD', currency: 'USD' },
      lines: [
        { category: 'BOX', quantity: '1', pricingFingerprint: price.pricingFingerprint },
        { category: 'BARREL', quantity: '2', pricingFingerprint: price.pricingFingerprint },
      ],
    });
    expect(body).not.toHaveProperty('newCustomerFromRequest');
  });

  it('books the sender registered on arrival', () => {
    const r = request({ instantAccount: { outcome: 'CREATED', customerId: 'c9' } as never });
    const plan = approvalPlan(r, 'SAR');
    if (typeof plan === 'string') throw new Error(plan);
    expect(approvalBody(r, plan, [price])).not.toHaveProperty('newCustomerFromRequest');
  });

  it("names the branch's first window when it has several points, else leaves it to the API", () => {
    const point = (id: string, outletName: string | null, branchId = 'b1') =>
      ({ id, branchId, outletName }) as never;
    const pick = (patch: Partial<CsBookingRequestStaffDto>) => {
      const plan = approvalPlan(request(patch), 'SAR');
      if (typeof plan === 'string') throw new Error(plan);
      return plan.dropOffId;
    };
    expect(pick({ dropOffChoices: [point('w1', 'Outlet')] })).toBeNull();
    expect(pick({ dropOffChoices: [point('h1', null), point('w2', 'Outlet')] })).toBe('w2');
    expect(pick({ dropOffChoices: [point('h1', null), point('h2', null)] })).toBeNull();
    expect(pick({ dropOffId: 'w3', dropOffChoices: [point('w2', 'Outlet')] })).toBe('w3');
  });

  it('leaves for staff what the form cannot approve as it opens', () => {
    expect(approvalPlan(request({ originId: null }), 'SAR')).toBe('no route or currency');
    expect(approvalPlan(request(), null)).toBe('no route or currency');
    expect(approvalPlan(request({ items: [{ isOther: true } as never] }), 'SAR')).toMatch(
      /outside/,
    );
    expect(approvalPlan(request({ category: null }), 'SAR')).toMatch(/category/);
    expect(
      approvalPlan(
        request({ profile: { id: 'p', version: 1, name: 'x', needsReview: true } as never }),
        'SAR',
      ),
    ).toMatch(/review/);
  });
});
