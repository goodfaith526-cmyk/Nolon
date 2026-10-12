// @vitest-environment jsdom
import type { BookingDto, CustomerDto } from '@nolon/shared';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.fn();
let permissions: string[] = ['customers:update'];

vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }));
vi.mock('@/i18n/navigation', () => ({ Link: () => null, useRouter: () => ({ push: () => {} }) }));
vi.mock('@/lib/api', () => ({ api: (...args: unknown[]) => api(...args) as unknown }));
vi.mock('@/lib/master-data', () => ({
  useMasterData: () => ({
    currencies: [],
    locations: [
      { id: 'l1', code: 'JEA', nameEn: 'Jebel Ali', isActive: true },
      { id: 'l2', code: 'PZU', nameEn: 'Port Sudan', isActive: true },
    ],
    containerTypes: [{ code: '20GP', nameEn: '20GP', isActive: true }],
  }),
  useLocalName: () => (x: { nameEn?: string }) => x.nameEn ?? '',
}));
vi.mock('../StaffShell', () => ({
  useMe: () => ({ permissions, branches: [{ id: 'b1', nameEn: 'Dubai', nameAr: 'دبي' }] }),
  can: (me: { permissions: string[] }, p: string) => me.permissions.includes(p),
}));
vi.mock('./Notice', () => ({ Notice: () => null, useFailureText: () => () => 'failed' }));

const { BookingForm } = await import('./BookingForm');

const booking = {
  id: 'bk1',
  number: 'NOL-BKG-000001',
  customerId: 'c1',
  originLocationId: 'l1',
  destinationLocationId: 'l2',
  mode: 'SEA',
  loadType: 'FCL',
  cargoType: 'CONTAINER',
  cargoDescription: null,
  services: ['MAIN_FREIGHT'],
  shipperId: null,
  consigneeId: null,
  notifyPartyId: null,
  requestedDeparture: null,
  specialInstructions: null,
  items: [],
} as unknown as BookingDto;

const party = (id: string, name: string) => ({
  id,
  name,
  companyName: null,
  phone: null,
  email: null,
  countryCode: null,
  city: null,
  address: null,
});
const customer = (parties: ReturnType<typeof party>[]) =>
  ({ id: 'c1', name: 'Tariq', parties }) as unknown as CustomerDto;

async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

function click(el: Element | null | undefined) {
  act(() => {
    (el as HTMLElement).click();
  });
}

const select = (name: string) =>
  document.querySelector(`select[name="${name}"]`) as HTMLSelectElement;
const addButton = (name: string) =>
  [...(select(name).parentElement?.querySelectorAll('button') ?? [])].find(
    (b) => b.textContent === 'addNewParty',
  );

describe('BookingForm parties', () => {
  let root: ReturnType<typeof createRoot>;

  async function render() {
    api.mockResolvedValueOnce(customer([party('p0', 'Old shipper')]));
    const host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    act(() => {
      root.render(<BookingForm booking={booking} />);
    });
    await flush();
  }

  beforeEach(() => {
    api.mockReset();
    permissions = ['customers:update'];
  });
  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
  });

  it('adds a consignee from its field, selects it, and does not submit the booking', async () => {
    await render();
    expect(addButton('shipperId')).toBeDefined();
    click(addButton('consigneeId'));

    const dialog = document.querySelector('dialog.form-dialog');
    expect(dialog?.closest('form:not(dialog form)')).toBeNull();
    const name = dialog?.querySelector('input[name="name"]') as HTMLInputElement;
    act(() => {
      // eslint-disable-next-line @typescript-eslint/unbound-method -- applied with the element as `this` below
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setValue?.call(name, 'Omdurman Trading');
      name.dispatchEvent(new Event('input', { bubbles: true }));
    });

    api.mockResolvedValueOnce(
      customer([party('p0', 'Old shipper'), party('p1', 'Omdurman Trading')]),
    );
    act(() => {
      (dialog?.querySelector('form') as HTMLFormElement).requestSubmit();
    });
    await flush();

    expect(api).toHaveBeenLastCalledWith('/customers/c1/parties', {
      method: 'POST',
      body: expect.objectContaining({ name: 'Omdurman Trading' }) as unknown,
    });
    expect(api).not.toHaveBeenCalledWith('/bookings/bk1', expect.anything());
    expect(document.querySelector('dialog.form-dialog')).toBeNull();
    expect(select('consigneeId').value).toBe('p1');
    expect(select('shipperId').value).toBe('');
    expect([...select('shipperId').options].map((o) => o.value)).toEqual(['', 'p0', 'p1']);
  });

  it('offers no new party without permission to update customers', async () => {
    permissions = [];
    await render();
    expect(addButton('shipperId')).toBeUndefined();
    expect(addButton('consigneeId')).toBeUndefined();
  });
});
