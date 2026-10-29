// @vitest-environment jsdom
import type { CsApprovalPriceDto, CsBookingRequestStaffDto, MasterDataDto } from '@nolon/shared';
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
});
