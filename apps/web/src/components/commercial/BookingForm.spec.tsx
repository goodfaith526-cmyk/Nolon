// @vitest-environment jsdom
import type { BookingDto, CustomerDto, CustomerPartyAddedDto } from '@nolon/shared';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api';

const api = vi.fn();
let permissions: string[] = ['customers:update'];

vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }));
vi.mock('@/i18n/navigation', () => ({ Link: () => null, useRouter: () => ({ push: () => {} }) }));
vi.mock('@/lib/api', async (actual) => ({
  ...(await actual<typeof import('@/lib/api')>()),
  api: (...args: unknown[]) => api(...args) as unknown,
}));
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
vi.mock('./Notice', async (actual) => ({
  ...(await actual<typeof import('./Notice')>()),
  Notice: () => null,
  useFailureText: () => () => 'failed',
}));

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

    // Someone else added "Another desk" to the same customer meanwhile: only this save's party is
    // selected, by the id the API returns, whatever the list order.
    api.mockResolvedValueOnce({
      ...customer([
        party('p0', 'Old shipper'),
        party('p2', 'Another desk'),
        party('p1', 'Omdurman Trading'),
      ]),
      addedPartyId: 'p1',
    });
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
    expect([...select('shipperId').options].map((o) => o.value)).toEqual(['', 'p0', 'p2', 'p1']);
  });

  it('drops a party saved for a customer the booking no longer has', async () => {
    const summary = (id: string, name: string) => ({
      id,
      name,
      number: id,
      phone: '+249912345678',
      isActive: true,
    });
    let finishSave: (c: CustomerPartyAddedDto) => void = () => {};
    api.mockImplementation((path: string) => {
      if (path.startsWith('/customers?')) {
        const id = path.includes('Second') ? 'c2' : 'c1';
        return Promise.resolve({ items: [summary(id, id)], total: 1, page: 1, pageSize: 20 });
      }
      if (path === '/customers/c1/parties') {
        return new Promise<CustomerPartyAddedDto>((resolve) => {
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
    finishSave({
      ...customer([party('c1-p', 'c1 party'), party('late', 'Late party')]),
      addedPartyId: 'late',
    });
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

describe('BookingForm refused save', () => {
  let root: ReturnType<typeof createRoot>;

  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
  });

  it('marks the fields the API names and moves to the first one; the next save clears them', async () => {
    api.mockReset();
    api.mockImplementation((path: string, init?: { method?: string }) => {
      if (init?.method === 'PATCH') {
        return Promise.reject(
          new ApiError(400, 'x', ['items.0.weightKg', 'services'], 'Weight is wrong', null),
        );
      }
      return Promise.resolve(customer([]));
    });
    const host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    act(() => {
      root.render(<BookingForm booking={booking} />);
    });
    await flush();
    click(buttonByText('addItem'));
    const weight = () =>
      [...document.querySelectorAll('label.field')]
        .find((l) => l.textContent?.startsWith('weightKg'))
        ?.querySelector('input') as HTMLInputElement;
    // An Arabic keyboard's digits are read as 0-9.
    typeInto(weight(), '١٢٫٥');
    expect(weight().value).toBe('12.5');
    // One dimension asks for the other two here, and the CBM then comes from them.
    const input = (k: string) =>
      [...document.querySelectorAll('label.field')]
        .find((l) => l.textContent?.startsWith(k))
        ?.querySelector('input') as HTMLInputElement;
    expect(input('lengthCm').required).toBe(false);
    typeInto(input('heightCm'), '100');
    expect(['lengthCm', 'widthCm', 'heightCm'].map((k) => input(k).required)).toEqual([
      true,
      true,
      true,
    ]);
    expect(input('volumeCbm').disabled).toBe(true);
    typeInto(input('heightCm'), '');

    act(() => {
      (document.querySelector('form') as HTMLFormElement).requestSubmit();
    });
    await flush();

    // The services above the lines are marked as a group; the first marked control has the focus.
    expect(weight().getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(weight());
    expect(document.querySelector('[data-invalid="true"]')?.classList.contains('checks')).toBe(
      true,
    );
    expect(document.querySelectorAll('[aria-invalid="true"]')).toHaveLength(1);
    // The reason is said once, under the first field named.
    const notes = [...document.querySelectorAll('.field-error')];
    expect(notes.map((n) => n.textContent)).toEqual(['Weight is wrong']);
    expect(notes[0]?.closest('label')?.contains(weight())).toBe(true);

    api.mockImplementation(() => new Promise(() => {}));
    act(() => {
      (document.querySelector('form') as HTMLFormElement).requestSubmit();
    });
    await flush();
    expect(document.querySelectorAll('[aria-invalid="true"], [data-invalid="true"]')).toHaveLength(
      0,
    );
    expect(document.querySelectorAll('.field-error')).toHaveLength(0);
  });
});

describe('BookingForm mode, cargo, services and CBM (owner, 2026-10-19)', () => {
  let root: ReturnType<typeof createRoot>;

  async function render(value: BookingDto = booking) {
    api.mockReset();
    api.mockResolvedValue(customer([]));
    const host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    act(() => {
      root.render(<BookingForm booking={value} />);
    });
    await flush();
  }

  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
  });

  const modeBox = (label: string) =>
    [...document.querySelectorAll('fieldset label')]
      .find((l) => l.textContent?.trim() === label)
      ?.querySelector('input') as HTMLInputElement;
  const fieldInput = (label: string, index = 0) =>
    [...document.querySelectorAll('label.field')]
      .filter((l) => l.textContent?.startsWith(label))
      [index]?.querySelector('input') as HTMLInputElement;

  it('sends sea and road together as SEA_ROAD and keeps FCL/LCL for it', async () => {
    await render();
    expect(modeBox('mode_SEA').checked).toBe(true);
    expect(modeBox('mode_ROAD').checked).toBe(false);
    // The only ticked leg cannot be unticked.
    expect(modeBox('mode_SEA').disabled).toBe(true);
    click(modeBox('mode_ROAD'));
    expect(modeBox('mode_SEA').disabled).toBe(false);
    api.mockResolvedValueOnce({ ...booking, id: 'bk1' });
    act(() => {
      (document.querySelector('form') as HTMLFormElement).requestSubmit();
    });
    await flush();
    expect(api).toHaveBeenCalledWith('/bookings/bk1', {
      method: 'PATCH',
      body: expect.objectContaining({ mode: 'SEA_ROAD', loadType: 'FCL' }) as unknown,
    });
  });

  it('offers container, pallet and barrel, and no main freight tick', async () => {
    await render();
    const cargo = [...document.querySelectorAll('select')].find((s) =>
      [...s.options].some((o) => o.value === 'BARREL'),
    );
    expect([...(cargo?.options ?? [])].map((o) => o.value)).toEqual([
      'CONTAINER',
      'PALLET',
      'BARREL',
    ]);
    expect(document.body.textContent).not.toContain('service_MAIN_FREIGHT');
    expect(document.body.textContent).toContain('service_CUSTOMS');
  });

  it('shows the CBM as the dimensions are typed', async () => {
    await render();
    click(buttonByText('addItem'));
    typeInto(fieldInput('quantity'), '10');
    typeInto(fieldInput('lengthCm'), '120');
    typeInto(fieldInput('widthCm'), '100');
    expect(fieldInput('volumeCbm').value).toBe('');
    typeInto(fieldInput('heightCm'), '150');
    expect(fieldInput('volumeCbm').value).toBe('18.0000');
    expect(fieldInput('volumeCbm').disabled).toBe(true);
  });
});
