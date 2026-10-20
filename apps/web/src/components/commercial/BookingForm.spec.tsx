// @vitest-environment jsdom
import type {
  BookingDto,
  BookingFromQuotationPreviewDto,
  BookingPartySuggestionDto,
  CustomerDto,
  CustomerPartyAddedDto,
} from '@nolon/shared';
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

function changeValue(el: HTMLSelectElement, value: string) {
  // eslint-disable-next-line @typescript-eslint/unbound-method -- applied with the element as `this` below
  const setValue = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
  act(() => {
    setValue?.call(el, value);
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

const routeSelects = () => [...document.querySelectorAll('select')].slice(0, 2);

describe('BookingForm from a quotation (functional review B1)', () => {
  let root: ReturnType<typeof createRoot>;

  const preview = {
    quotationId: 'q1',
    quotationNumber: 'QT-1',
    branchId: 'b1',
    customerId: 'c1',
    customerName: 'Tariq',
    originLocationId: 'l1',
    destinationLocationId: 'l2',
    mode: 'SEA',
    loadType: 'FCL',
    cargoType: 'CONTAINER',
    cargoDescription: 'Tyres',
    items: [{ cargoType: 'CONTAINER', containerTypeCode: '20GP', quantity: 2 }],
    parties: {
      customerId: 'c1',
      source: 'LAST_BOOKING',
      bookingId: 'bk0',
      bookingNumber: 'BK-9',
      shipperId: 'p1',
      consigneeId: null,
      notifyPartyId: null,
    },
  } satisfies BookingFromQuotationPreviewDto;

  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
  });

  it('opens filled from the quotation, creates nothing, and saves through from-quotation', async () => {
    api.mockReset();
    api.mockImplementation((path: string) =>
      path === '/customers/c1'
        ? Promise.resolve(customer([party('p1', 'Shipper'), party('p2', 'Other')]))
        : Promise.resolve({ ...booking, id: 'bk2' }),
    );
    const host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    act(() => {
      root.render(<BookingForm fromQuotation={preview} />);
    });
    await flush();

    // Opening reads the customer's parties only: nothing is written.
    expect(api.mock.calls.map((c) => c[0] as string)).toEqual(['/customers/c1']);
    expect(document.body.textContent).toContain('fromQuotationTitle');
    expect(document.body.textContent).toContain('Tariq');
    // Route, mode, load type and cargo are the quotation's and cannot change here.
    expect(routeSelects().map((s) => [s.value, s.disabled])).toEqual([
      ['l1', true],
      ['l2', true],
    ]);
    const quantity = [...document.querySelectorAll('label.field')]
      .find((l) => l.textContent?.startsWith('quantity'))
      ?.querySelector('input') as HTMLInputElement;
    expect(quantity.value).toBe('2');
    expect(document.body.textContent).toContain('itemsFromQuotation');
    // The suggested shipper, with where it comes from.
    expect(select('shipperId').value).toBe('p1');
    expect(document.body.textContent).toContain('partiesFromLastBooking');

    act(() => {
      (document.querySelector('form') as HTMLFormElement).requestSubmit();
    });
    await flush();
    expect(api).toHaveBeenCalledWith('/bookings/from-quotation/q1', {
      method: 'POST',
      body: {
        services: [],
        shipperId: 'p1',
        consigneeId: null,
        notifyPartyId: null,
        requestedDeparture: null,
        specialInstructions: null,
        items: [
          {
            cargoType: 'CONTAINER',
            containerTypeCode: '20GP',
            description: null,
            quantity: 2,
            lengthCm: null,
            widthCm: null,
            heightCm: null,
            weightKg: null,
            volumeCbm: null,
          },
        ],
      },
    });
    expect(api).not.toHaveBeenCalledWith('/bookings', expect.anything());
  });

  it('shows a quotation without a load type as not set, not FCL (Codex F93-4)', async () => {
    api.mockReset();
    api.mockResolvedValue(customer([]));
    const host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    act(() => {
      root.render(<BookingForm fromQuotation={{ ...preview, loadType: null }} />);
    });
    await flush();
    const loadType = [...document.querySelectorAll('select')].find((s) =>
      [...s.options].some((o) => o.value === 'LCL'),
    ) as HTMLSelectElement;
    expect(loadType.disabled).toBe(true);
    expect(loadType.value).toBe('');
    expect(loadType.selectedOptions[0]?.textContent).toBe('notSet');
  });

  it('starts with one empty line when the quotation prices no containers', async () => {
    api.mockReset();
    api.mockResolvedValue(customer([]));
    const host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    act(() => {
      root.render(
        <BookingForm
          fromQuotation={{
            ...preview,
            cargoType: 'PALLET',
            loadType: 'LCL',
            items: [],
            parties: { ...preview.parties, source: null, shipperId: null },
          }}
        />,
      );
    });
    await flush();
    expect(document.querySelectorAll('.line')).toHaveLength(1);
    expect(document.body.textContent).not.toContain('itemsFromQuotation');
    expect(document.body.textContent).not.toContain('partiesFrom');
    expect(select('shipperId').value).toBe('');
  });
});

describe('BookingForm new booking: empty route and suggested parties (functional review B5, B6)', () => {
  let root: ReturnType<typeof createRoot>;

  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
  });

  const summary = (id: string) => ({
    id,
    name: id,
    number: id,
    phone: '+249912345678',
    isActive: true,
  });
  const suggestionFor = (id: string): BookingPartySuggestionDto =>
    id === 'c1'
      ? {
          customerId: 'c1',
          source: 'LAST_BOOKING',
          bookingId: 'bk0',
          bookingNumber: 'BK-9',
          shipperId: 'c1-s',
          consigneeId: 'c1-c',
          notifyPartyId: null,
        }
      : {
          customerId: id,
          source: null,
          bookingId: null,
          bookingNumber: null,
          shipperId: null,
          consigneeId: null,
          notifyPartyId: null,
        };

  async function renderNew() {
    api.mockReset();
    api.mockImplementation((path: string) => {
      if (path.startsWith('/customers?')) {
        const id = path.includes('Second') ? 'c2' : 'c1';
        return Promise.resolve({ items: [summary(id)], total: 1, page: 1, pageSize: 20 });
      }
      if (path.startsWith('/bookings/party-suggestion?customerId=')) {
        return Promise.resolve(suggestionFor(path.split('=')[1] ?? ''));
      }
      const id = path.split('/')[2] ?? '';
      return Promise.resolve({
        ...customer([]),
        id,
        parties: [party(`${id}-s`, 'Shipper'), party(`${id}-c`, 'Consignee')],
      });
    });
    const host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    act(() => {
      root.render(<BookingForm />);
    });
    await flush();
  }

  const pick = async (q: string, id: string) => {
    typeInto(document.querySelector('input[type="search"]') as HTMLInputElement, q);
    click(buttonByText('search'));
    await flush();
    click(buttonStartingWith(id));
    await flush();
  };

  it('starts with no origin or destination picked', async () => {
    await renderNew();
    expect(routeSelects().map((s) => s.value)).toEqual(['', '']);
    expect(routeSelects().every((s) => s.required)).toBe(true);
  });

  it('does not refill a party the person cleared before a late suggestion (Codex F93-3)', async () => {
    await renderNew();
    let answer: (s: BookingPartySuggestionDto) => void = () => {};
    const fallback = api.getMockImplementation() as (path: string) => Promise<unknown>;
    api.mockImplementation((path: string) =>
      path.startsWith('/bookings/party-suggestion?')
        ? new Promise<BookingPartySuggestionDto>((resolve) => {
            answer = resolve;
          })
        : fallback(path),
    );
    await pick('First', 'c1');
    // The person picks a shipper, then clears it, before the suggestion answers.
    changeValue(select('shipperId'), 'c1-c');
    changeValue(select('shipperId'), '');
    await act(async () => {
      answer(suggestionFor('c1'));
      await Promise.resolve();
    });
    await flush();
    expect(select('shipperId').value).toBe('');
    // A field never touched still takes the suggestion.
    expect(select('consigneeId').value).toBe('c1-c');
  });

  it("suggests the customer's last booking parties, keeps a change, and drops them for another customer", async () => {
    await renderNew();
    await pick('First', 'c1');
    expect(api).toHaveBeenCalledWith('/bookings/party-suggestion?customerId=c1');
    expect(select('shipperId').value).toBe('c1-s');
    expect(select('consigneeId').value).toBe('c1-c');
    expect(select('notifyPartyId').value).toBe('');
    expect(document.body.textContent).toContain('partiesFromLastBooking');

    // The person's own choice stays; the note stays while a suggested party is still selected.
    changeValue(select('consigneeId'), 'c1-s');
    expect(select('consigneeId').value).toBe('c1-s');
    expect(document.body.textContent).toContain('partiesFromLastBooking');
    changeValue(select('shipperId'), '');
    expect(document.body.textContent).not.toContain('partiesFromLastBooking');

    // Another customer: the old suggestion and choices go; this one suggests nothing.
    click(buttonByText('change'));
    await pick('Second', 'c2');
    expect(PARTY_SELECTS.map((n) => select(n).value)).toEqual(['', '', '']);
    expect(document.body.textContent).not.toContain('partiesFrom');
  });
});

const PARTY_SELECTS = ['shipperId', 'consigneeId', 'notifyPartyId'];
