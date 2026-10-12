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

function typeInto(el: HTMLInputElement, value: string) {
  // eslint-disable-next-line @typescript-eslint/unbound-method -- applied with the element as `this` below
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  act(() => {
    setValue?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const buttonByText = (text: string) =>
  [...document.querySelectorAll('button')].find((b) => b.textContent === text);
const buttonStartingWith = (text: string) =>
  [...document.querySelectorAll('ul.picker button')].find((b) => b.textContent?.startsWith(text));

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
    typeInto(name, 'Omdurman Trading');

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

  it('drops a party saved for a customer the booking no longer has', async () => {
    const summary = (id: string, name: string) => ({
      id,
      name,
      number: id,
      phone: '+249912345678',
      isActive: true,
    });
    let finishSave: (c: CustomerDto) => void = () => {};
    api.mockImplementation((path: string) => {
      if (path.startsWith('/customers?')) {
        const id = path.includes('Second') ? 'c2' : 'c1';
        return Promise.resolve({ items: [summary(id, id)], total: 1, page: 1, pageSize: 20 });
      }
      if (path === '/customers/c1/parties') {
        return new Promise<CustomerDto>((resolve) => {
          finishSave = resolve;
        });
      }
      const id = path.split('/')[2] ?? '';
      return Promise.resolve({ ...customer([]), id, parties: [party(`${id}-p`, `${id} party`)] });
    });
    const host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    act(() => {
      root.render(<BookingForm />);
    });
    await flush();

    const pick = async (q: string, id: string) => {
      typeInto(document.querySelector('input[type="search"]') as HTMLInputElement, q);
      click(buttonByText('search'));
      await flush();
      click(buttonStartingWith(id));
      await flush();
    };
    await pick('First', 'c1');
    click(addButton('consigneeId'));
    const dialog = document.querySelector('dialog.form-dialog');
    typeInto(dialog?.querySelector('input[name="name"]') as HTMLInputElement, 'Late party');
    act(() => {
      (dialog?.querySelector('form') as HTMLFormElement).requestSubmit();
    });
    await flush();

    click(buttonByText('change'));
    expect(document.querySelector('dialog.form-dialog')).toBeNull();
    await pick('Second', 'c2');
    finishSave({ ...customer([party('c1-p', 'c1 party'), party('late', 'Late party')]) });
    await flush();

    expect(select('consigneeId').value).toBe('');
    expect([...select('consigneeId').options].map((o) => o.value)).toEqual(['', 'c2-p']);
  });

  it('offers no new party without permission to update customers', async () => {
    permissions = [];
    await render();
    expect(addButton('shipperId')).toBeUndefined();
    expect(addButton('consigneeId')).toBeUndefined();
  });
});
