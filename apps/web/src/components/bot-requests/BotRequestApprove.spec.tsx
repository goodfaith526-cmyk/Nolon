// @vitest-environment jsdom
import type {
  CsApprovalPriceDto,
  CsApproveRequest,
  CsBookingRequestStaffDto,
  MasterDataDto,
} from '@nolon/shared';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const calls: string[] = [];
const priced: CsApprovalPriceDto = {
  state: 'priced',
  reason: null,
  rateCardId: 'card1',
  approvedAt: '2026-10-01T00:00:00.000Z',
  currency: 'USD',
  unit: 'PER_BARREL',
  unitPrice: '40',
  minimumCharge: '0',
  total: '80.00',
  pricingFingerprint: 'a'.repeat(64),
};

vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }));
vi.mock('@/lib/master-data', () => ({
  isPlace: () => true,
  useLocalName: () => (l: { nameEn: string }) => l.nameEn,
}));
vi.mock('@/lib/api', () => ({
  api: (path: string) => {
    calls.push(path);
    return Promise.resolve(priced);
  },
}));
vi.mock('../commercial/CustomerPicker', () => ({ CustomerPicker: () => null }));
vi.mock('../commercial/ModePicker', () => ({ ModePicker: () => null }));
const { BotRequestApprove } = await import('./BotRequestApprove');

const request = {
  id: 'r1',
  version: 4,
  status: 'pending',
  branchId: 'b-pts',
  originId: 'jed',
  destinationId: 'krt',
  category: 'BARREL',
  quantity: '2',
  customerId: 'c1',
  customerNumber: 'C-0009',
  services: ['PICKUP'],
  requestedDate: null,
  priceCheck: null,
  botQuotedPrice: { amount: '550', currency: 'USD' },
  items: [],
  bookingLines: [],
  dropOffId: null,
  dropOffPoint: null,
  estimate: null,
  photos: [],
  dropOffChoices: [],
} as unknown as CsBookingRequestStaffDto;
const master = {
  locations: [
    { id: 'jed', code: 'JED', nameEn: 'Jeddah', isActive: true },
    { id: 'krt', code: 'KRT', nameEn: 'Khartoum', isActive: true },
  ],
  currencies: [{ code: 'USD', isActive: true }],
  priceCategories: [
    { code: 'BARREL', nameEn: 'Barrel', cargoType: 'GENERAL', defaultUnit: 'PER_BARREL' },
  ],
} as unknown as MasterDataDto;

let host: HTMLElement | null = null;
afterEach(() => {
  host?.remove();
  host = null;
  calls.length = 0;
});

describe('BotRequestApprove', () => {
  it('uses the bound profile without selecting a branch customer and sends its displayed version', async () => {
    const approved = vi.fn();
    host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    act(() =>
      root.render(
        <BotRequestApprove
          request={{
            ...request,
            customerId: null,
            profile: {
              id: 'p1',
              number: 'CP000001',
              name: 'Explicit sender',
              phone: null,
              version: 7,
            },
          }}
          master={master}
          busy={false}
          onApprove={approved}
        />,
      ),
    );
    expect(host.textContent).toContain('Explicit sender');
    const check = [...host.querySelectorAll('button')].find((b) => b.textContent === 'checkPrice')!;
    await act(async () => {
      check.click();
      await Promise.resolve();
    });
    const submit = host.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    expect(submit.disabled).toBe(false);
    await act(async () => {
      submit.form!.requestSubmit();
      await Promise.resolve();
    });
    expect(approved).toHaveBeenCalledWith(
      expect.objectContaining({
        profileVersion: 7,
        booking: { services: ['PICKUP'], requestedDeparture: null },
      }),
    );
    act(() => root.unmount());
  });
  it('explains a missing explicit profile name and keeps approval disabled', async () => {
    host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    act(() =>
      root.render(
        <BotRequestApprove
          request={{
            ...request,
            customerId: null,
            profile: { id: 'p1', number: 'CP000001', name: null, phone: null, version: 1 },
          }}
          master={master}
          busy={false}
          onApprove={() => undefined}
        />,
      ),
    );
    expect(host.textContent).toContain('profileNameRequired');
    const check = [...host.querySelectorAll('button')].find((b) => b.textContent === 'checkPrice')!;
    await act(async () => {
      check.click();
      await Promise.resolve();
    });
    expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
    act(() => root.unmount());
  });
  it('approves only with the price checked for the inputs as they are', async () => {
    const approved = vi.fn();
    host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    act(() =>
      root.render(
        <BotRequestApprove request={request} master={master} busy={false} onApprove={approved} />,
      ),
    );
    const submit = host.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    expect(submit.disabled).toBe(true);

    const check = [...host.querySelectorAll('button')].find((b) => b.textContent === 'checkPrice')!;
    await act(async () => {
      check.click();
      await Promise.resolve();
    });
    expect(calls[0]).toContain('/cs-booking-requests/r1/price?');
    expect(calls[0]).toContain('quantity=2');
    expect(host.textContent).toContain('80.00 USD');
    expect(submit.disabled).toBe(false);

    await act(async () => {
      submit.form!.requestSubmit();
      await Promise.resolve();
    });
    expect(approved).toHaveBeenCalledWith({
      version: 4,
      paymentCurrency: 'USD',
      pricing: {
        originId: 'jed',
        destinationId: 'krt',
        mode: 'SEA',
        category: 'BARREL',
        quantity: '2',
        currency: 'USD',
      },
      pricingFingerprint: 'a'.repeat(64),
      booking: { customerId: 'c1', services: ['PICKUP'], requestedDeparture: null },
    });

    // A changed input needs the price again.
    const origin = host.querySelector<HTMLSelectElement>('select')!;
    await act(async () => {
      origin.value = 'krt';
      origin.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });
    expect(submit.disabled).toBe(true);
  });
  it('prices a request with items line by line as it opens and sends one line per item', async () => {
    const approved = vi.fn();
    host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const item = (id: string, lineNo: number, quantity: string) => ({
      id,
      lineNo,
      category: 'BARREL',
      botKind: null,
      isOther: false,
      description: null,
      quantity,
      pieces: null,
      dimensions: null,
      weightKg: null,
      quoteRef: null,
      approvedTotal: null,
      bookingItemId: null,
    });
    act(() =>
      root.render(
        <BotRequestApprove
          request={{ ...request, items: [item('i1', 1, '2'), item('i2', 2, '3')] }}
          master={master}
          busy={false}
          onApprove={approved}
        />,
      ),
    );
    // Client request 2026-11-04: a complete request is priced as the form opens, once.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain('quantity=3');
    // Two lines priced 80.00 each: their sum, shown as a decimal string.
    expect(host.textContent).toContain('160.00 USD');
    const submit = host.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    await act(async () => {
      submit.form!.requestSubmit();
      await Promise.resolve();
    });
    expect(approved).toHaveBeenCalledWith(
      expect.objectContaining({
        pricing: { originId: 'jed', destinationId: 'krt', mode: 'SEA', currency: 'USD' },
        lines: [
          { category: 'BARREL', quantity: '2', pricingFingerprint: 'a'.repeat(64) },
          { category: 'BARREL', quantity: '3', pricingFingerprint: 'a'.repeat(64) },
        ],
      }),
    );
    expect(approved.mock.calls[0]![0]).not.toHaveProperty('pricingFingerprint');
    act(() => root.unmount());
  });
  it('books a new customer from an unlinked request by default, or a chosen one instead', async () => {
    const approved = vi.fn();
    host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const unlinked = {
      ...request,
      customerId: null,
      customerNumber: null,
      profile: null,
      senderName: 'Web Sender',
      contactPhone: '+971500000001',
    } as unknown as CsBookingRequestStaffDto;
    act(() =>
      root.render(
        <BotRequestApprove request={unlinked} master={master} busy={false} onApprove={approved} />,
      ),
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(host.textContent).toContain('newCustomerFromRequest');
    expect(host.textContent).toContain('+971500000001');
    const submit = host.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    await act(async () => {
      submit.form!.requestSubmit();
      await Promise.resolve();
    });
    expect(approved).toHaveBeenCalledTimes(1);
    expect(approved.mock.calls[0]![0]).toMatchObject({ newCustomerFromRequest: true });
    expect((approved.mock.calls[0]![0] as CsApproveRequest).booking).not.toHaveProperty(
      'customerId',
    );

    // Choosing an existing customer instead: no new customer, and none chosen yet, so no approval.
    const choose = [...host.querySelectorAll('button')].find(
      (b) => b.textContent === 'chooseExistingCustomer',
    )!;
    act(() => choose.click());
    expect(host.textContent).toContain('useRequestCustomer');
    await act(async () => {
      submit.form!.requestSubmit();
      await Promise.resolve();
    });
    expect(approved).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
  });
  it('holds approval of a request with a non-standard item', () => {
    host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    act(() =>
      root.render(
        <BotRequestApprove
          request={{
            ...request,
            items: [
              {
                id: 'i1',
                lineNo: 1,
                category: null,
                botKind: null,
                isOther: true,
                description: 'A sofa',
                quantity: null,
                pieces: 1,
                dimensions: null,
                weightKg: null,
                quoteRef: null,
                approvedTotal: null,
                bookingItemId: null,
              },
            ],
          }}
          master={master}
          busy={false}
          onApprove={() => undefined}
        />,
      ),
    );
    expect(host.textContent).toContain('estimateRequired');
    expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
    act(() => root.unmount());
  });

  it('approves a request with a non-standard item at the estimate the customer accepted', async () => {
    const approved = vi.fn();
    host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const other = {
      id: 'i1',
      lineNo: 1,
      category: null,
      botKind: null,
      isOther: true,
      description: 'A sofa',
      quantity: null,
      pieces: 1,
      dimensions: null,
      weightKg: null,
      quoteRef: null,
      approvedTotal: null,
      bookingItemId: null,
    };
    act(() =>
      root.render(
        <BotRequestApprove
          request={{
            ...request,
            items: [other],
            estimate: {
              version: 2,
              amount: '150',
              currency: 'USD',
              note: null,
              validUntil: new Date(Date.now() + 86_400_000).toISOString(),
              acceptedVersion: 2,
              acceptedAt: new Date().toISOString(),
              terms: {
                originId: request.originId!,
                destinationId: request.destinationId!,
                mode: 'ROAD',
                loadType: null,
              },
            },
          }}
          master={master}
          busy={false}
          onApprove={approved}
        />,
      ),
    );
    expect(host.textContent).toContain('approveAtEstimate');
    expect(host.textContent).toContain('150 USD');
    // No engine price to check: the estimate is the price.
    expect([...host.querySelectorAll('button')].some((b) => b.textContent === 'checkPrice')).toBe(
      false,
    );
    const submit = host.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    expect(submit.disabled).toBe(false);
    await act(async () => {
      submit.form!.requestSubmit();
      await Promise.resolve();
    });
    const body = approved.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body).not.toHaveProperty('lines');
    expect(body).not.toHaveProperty('pricingFingerprint');
    // Codex F171-2: the estimate's terms, which staff cannot change here.
    expect(body.pricing).toMatchObject({
      originId: request.originId,
      destinationId: request.destinationId,
      mode: 'ROAD',
      currency: 'USD',
    });
    expect(host.querySelectorAll('select:disabled')).toHaveLength(2);
    act(() => root.unmount());
  });
});
