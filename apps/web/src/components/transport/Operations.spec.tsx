// @vitest-environment jsdom
import type {
  CarrierDto,
  DriverDto,
  ShipmentDto,
  ShipmentWarehouseDto,
  SupplierSummaryDto,
  TripDto,
  VehicleDto,
} from '@nolon/shared';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Functional review, group D (operations): the forms' suggestions and the combined trip step. */

const api = vi.fn();
const DUBAI = { id: 'b1', code: 'DXB', nameEn: 'Dubai', today: '2026-10-19' };
const JEDDAH = { id: 'b2', code: 'JED', nameEn: 'Jeddah', today: '2026-10-19' };
const ME = { permissions: ['*'], allBranches: false, branches: [DUBAI, JEDDAH] };
const failed = () => 'failed';
const location = (id: string, code: string) => ({
  id,
  code,
  nameEn: code,
  nameAr: code,
  isActive: true,
});

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => 'en',
}));
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
  useRouter: () => ({ push: () => {} }),
}));
vi.mock('@/lib/api', async (actual) => ({
  ...(await actual<typeof import('@/lib/api')>()),
  api: (...args: unknown[]) => api(...args) as unknown,
}));
vi.mock('@/lib/master-data', async (actual) => ({
  ...(await actual<typeof import('@/lib/master-data')>()),
  useMasterData: () => ({
    branches: [DUBAI, JEDDAH],
    currencies: [{ code: 'USD', isActive: true }],
    locations: [location('l1', 'SDPZU'), location('l2', 'SDATB'), location('l3', 'SDKRT')],
    containerTypes: [
      { code: '20GP', isActive: true },
      { code: '40HC', isActive: true },
    ],
    chargeTypes: [],
  }),
  useLocalName: () => (x: { nameEn?: string }) => x.nameEn ?? '',
  useLocationName: () => (id: string) => id,
}));
vi.mock('../StaffShell', () => ({ useMe: () => ME, can: () => true }));
vi.mock('../commercial/Notice', async (actual) => ({
  ...(await actual<typeof import('../commercial/Notice')>()),
  useFailureText: () => failed,
}));
vi.mock('../warehouse/GrnDrafts', () => ({ GrnDrafts: () => null }));

const { TripForm } = await import('./TripForm');
const { TripDetail } = await import('./TripDetail');
const { Carriers, Drivers } = await import('./Fleet');
const { ShipmentWarehouse } = await import('../warehouse/ShipmentWarehouse');
const { ShipmentContainers } = await import('../shipments/ShipmentContainers');
const { ShipmentCustoms } = await import('../customs/ShipmentCustoms');

async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

function change(el: HTMLSelectElement | HTMLInputElement, value: string) {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement : HTMLInputElement;
  // eslint-disable-next-line @typescript-eslint/unbound-method -- applied with the element as `this` below
  const setValue = Object.getOwnPropertyDescriptor(proto.prototype, 'value')?.set;
  act(() => {
    setValue?.call(el, value);
    el.dispatchEvent(
      new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }),
    );
  });
}

async function click(el: Element | null | undefined) {
  if (!el) throw new Error('Nothing to click');
  act(() => {
    (el as HTMLElement).click();
  });
  await flush();
}

/** The select or input of the label whose text starts with `text` (translation keys here). */
function control<T extends HTMLSelectElement | HTMLInputElement>(text: string, nth = 0): T {
  const labels = [...document.querySelectorAll('label')].filter(
    (l) => (l.firstChild?.textContent ?? '').trim() === text,
  );
  const found = labels[nth]?.querySelector('select, input');
  if (!found) throw new Error(`No field ${text}`);
  return found as T;
}

const button = (text: string) =>
  [...document.querySelectorAll('button')].find((b) => b.textContent === text) ?? null;
const shows = (text: string) => document.body.textContent.includes(text);

let root: ReturnType<typeof createRoot>;

async function render(node: React.ReactNode) {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root.render(node));
  await flush();
}

const shipment = (overrides: Partial<ShipmentDto> = {}): ShipmentDto =>
  ({
    id: 's1',
    number: 'NOL-SHP-1',
    branchId: 'b2',
    sharedBranchIds: [],
    customerName: 'Tariq',
    status: 'ARRIVED_PORT',
    loadType: 'FCL',
    originLocationId: 'l2',
    destinationLocationId: 'l3',
    currentLocationId: 'l1',
    items: [],
    containers: [],
    actions: { transitions: [], canEdit: true },
    ...overrides,
  }) as unknown as ShipmentDto;

beforeEach(() => {
  api.mockReset();
});
afterEach(() => {
  act(() => root.unmount());
  document.body.replaceChildren();
});

describe('new trip from a shipment (D2) and the driver’s last vehicle (D8)', () => {
  const vehicles = [
    { id: 'v1', branchId: 'b2', plateNumber: 'P1', vehicleType: 't', isActive: true },
    { id: 'v2', branchId: 'b2', plateNumber: 'P2', vehicleType: 't', isActive: true },
  ] as VehicleDto[];
  const drivers = [
    { id: 'd1', branchId: 'b2', name: 'Ali', isActive: true },
    { id: 'd2', branchId: 'b2', name: 'Omar', isActive: true },
  ] as DriverDto[];

  beforeEach(() => {
    api.mockImplementation((path: string) => {
      if (path === '/shipments/s1') return Promise.resolve(shipment());
      if (path === '/transport/vehicles') return Promise.resolve(vehicles);
      if (path === '/transport/drivers') return Promise.resolve(drivers);
      if (path === '/transport/carriers') return Promise.resolve([]);
      if (path === '/transport/drivers/d1/last-vehicle') {
        return Promise.resolve({
          lastVehicle: { vehicleId: 'v2', plateNumber: 'P2', tripId: 't9', tripNumber: 'T-9' },
        });
      }
      if (path === '/transport/drivers/d2/last-vehicle') {
        return Promise.resolve({ lastVehicle: null });
      }
      return Promise.reject(new Error(path));
    });
  });

  it("starts from the shipment's branch and route, as visible suggestions that stay editable", async () => {
    await render(<TripForm shipmentId="s1" />);
    expect(control<HTMLSelectElement>('branch').value).toBe('b2');
    expect(control<HTMLSelectElement>('origin').value).toBe('l1');
    expect(control<HTMLSelectElement>('destination').value).toBe('l3');
    expect(shows('originFromShipment')).toBe(true);
    expect(shows('destinationFromShipment')).toBe(true);
    expect(shows('NOL-SHP-1')).toBe(true);

    change(control('origin'), 'l2');
    expect(control<HTMLSelectElement>('origin').value).toBe('l2');
    expect(shows('originFromShipment')).toBe(false);
    // Taking the shipment off drops the suggestion that came from it, not the person's pick.
    await click(button('remove'));
    expect(control<HTMLSelectElement>('destination').value).toBe('');
    expect(control<HTMLSelectElement>('origin').value).toBe('l2');
  });

  it("suggests the vehicle of the driver's last trip until the person picks one", async () => {
    await render(<TripForm shipmentId="s1" />);
    expect(control<HTMLSelectElement>('driver').value).toBe('d1');
    expect(control<HTMLSelectElement>('vehicle').value).toBe('v2');
    expect(shows('vehicleFromLastTrip')).toBe(true);
    // A driver without a last trip: no suggestion, the first vehicle as before.
    change(control('driver'), 'd2');
    await flush();
    expect(control<HTMLSelectElement>('vehicle').value).toBe('v1');
    expect(shows('vehicleFromLastTrip')).toBe(false);
    change(control('driver'), 'd1');
    await flush();
    expect(control<HTMLSelectElement>('vehicle').value).toBe('v2');
    // The person's pick is kept when the driver changes.
    change(control('vehicle'), 'v1');
    change(control('driver'), 'd2');
    await flush();
    change(control('driver'), 'd1');
    await flush();
    expect(control<HTMLSelectElement>('vehicle').value).toBe('v1');
    expect(shows('vehicleFromLastTrip')).toBe(false);
  });
});

describe('own trip: arrived and completed in one step (D7)', () => {
  const trip = (overrides: Partial<TripDto>): TripDto =>
    ({
      id: 't1',
      number: 'T-1',
      kind: 'OWN',
      status: 'DEPARTED',
      branchId: 'b1',
      originLocationId: 'l1',
      destinationLocationId: 'l3',
      shipments: [],
      expenses: [],
      cashAccounts: [],
      accrualShares: [],
      showsCost: false,
      departureRevision: 0,
      departureUndos: [],
      actions: {
        moves: ['ARRIVED'],
        canCancel: false,
        canEditShipments: false,
        canAddExpense: false,
        canCancelExpense: false,
        canUndoDeparture: false,
      },
      ...overrides,
    }) as unknown as TripDto;
  const arrived = trip({
    status: 'ARRIVED',
    actions: { ...trip({}).actions, moves: ['COMPLETED'] },
  });
  const completed = trip({ status: 'COMPLETED', actions: { ...trip({}).actions, moves: [] } });
  const moves = () =>
    api.mock.calls
      .filter(([path]) => path === '/trips/t1/status')
      .map(([, init]) => (init as { body: { status: string } }).body.status);

  it('records the arrival, then the completion, through the two API steps', async () => {
    api.mockImplementation((path: string, init?: { body: { status: string } }) => {
      if (path === '/trips/t1' && !init) return Promise.resolve(trip({}));
      return Promise.resolve(init?.body.status === 'ARRIVED' ? arrived : completed);
    });
    await render(<TripDetail id="t1" />);
    await click(button('arriveAndComplete'));
    expect(moves()).toEqual(['ARRIVED', 'COMPLETED']);
    expect(shows('arrivedAndCompletedNotice')).toBe(true);
    expect(button('move_COMPLETED')).toBeNull();
  });

  it('says so when the completion is refused, and offers only "complete"', async () => {
    api.mockImplementation((path: string, init?: { body: { status: string } }) => {
      if (path === '/trips/t1' && !init) return Promise.resolve(trip({}));
      if (init?.body.status === 'ARRIVED') return Promise.resolve(arrived);
      return Promise.reject(new Error('refused'));
    });
    await render(<TripDetail id="t1" />);
    await click(button('arriveAndComplete'));
    expect(moves()).toEqual(['ARRIVED', 'COMPLETED']);
    expect(shows('arrivedNotCompleted')).toBe(true);
    expect(shows('arrivedAndCompletedNotice')).toBe(false);
    // The trip shows as arrived: one "complete" button, no second arrival.
    expect(button('move_COMPLETED')).not.toBeNull();
    expect(button('arriveAndComplete')).toBeNull();
    expect(button('move_ARRIVED')).toBeNull();
  });

  it('B3-4: takes back a departure on the revision shown, keeping one request id per attempt', async () => {
    const departed = trip({
      departureRevision: 2,
      actions: { ...trip({}).actions, canUndoDeparture: true },
    });
    api.mockImplementation((path: string, init?: object) => {
      if (path === '/trips/t1' && !init) return Promise.resolve(departed);
      return Promise.reject(new Error('refused'));
    });
    await render(<TripDetail id="t1" />);
    await click(button('undoDeparture'));
    const reason = document.querySelector<HTMLTextAreaElement>('textarea[name="reason"]');
    if (!reason) throw new Error('No reason');
    reason.value = 'Left by mistake';
    const submit = async () => {
      act(() => reason.form?.requestSubmit());
      await flush();
    };
    await submit();
    await submit();
    const sent = api.mock.calls
      .filter(([path]) => path === '/trips/t1/undo-departure')
      .map(([, init]) => (init as { body: { requestId: string } }).body);
    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatchObject({
      expectedRevision: 2,
      expectedStatus: 'DEPARTED',
      reason: 'Left by mistake',
    });
    expect(sent[1]?.requestId).toBe(sent[0]?.requestId);
  });

  it('is not offered on an external trip', async () => {
    api.mockResolvedValue(trip({ kind: 'EXTERNAL' }));
    await render(<TripDetail id="t1" />);
    expect(button('move_ARRIVED')).not.toBeNull();
    expect(button('arriveAndComplete')).toBeNull();
  });
});

describe('fleet: driver name from the user (D6), carrier and supplier (D3)', () => {
  it("fills a new driver's name from the linked user, keeping a typed name", async () => {
    api.mockImplementation((path: string) =>
      Promise.resolve(
        path === '/transport/driver-users'
          ? [
              { id: 'u1', fullName: 'Ahmed Ali', email: 'a@x' },
              { id: 'u2', fullName: 'Sara Omer', email: 's@x' },
            ]
          : [],
      ),
    );
    await render(<Drivers />);
    const name = () => control<HTMLInputElement>('name');
    change(control('linkedUser'), 'u1');
    expect(name().value).toBe('Ahmed Ali');
    expect(shows('nameFromUser')).toBe(true);
    // Another user replaces a name that came from a user.
    change(control('linkedUser'), 'u2');
    expect(name().value).toBe('Sara Omer');
    // A typed name stays.
    change(name(), 'Sara O.');
    change(control('linkedUser'), 'u1');
    expect(name().value).toBe('Sara O.');
    expect(shows('nameFromUser')).toBe(false);
  });

  const carriers = [
    { id: 'c1', name: 'Nile', phone: null, supplierId: null, supplierName: null, isActive: true },
    {
      id: 'c2',
      name: 'Red Sea',
      phone: null,
      supplierId: 'p1',
      supplierName: 'Red Sea Co',
      isActive: true,
    },
  ] as CarrierDto[];
  const supplier = { id: 'p9', number: 'SUP-9', name: 'Nile', phone: null, isActive: true };

  it('shows the link, offers an existing supplier instead of a duplicate, else creates one', async () => {
    let matches: SupplierSummaryDto[] = [supplier];
    api.mockImplementation((path: string) => {
      if (path === '/transport/carriers') return Promise.resolve(carriers);
      if (path.startsWith('/suppliers?')) return Promise.resolve({ items: [] });
      if (path.startsWith('/suppliers/matching-carrier/')) return Promise.resolve(matches);
      return Promise.resolve({});
    });
    await render(<Carriers />);
    expect(shows('notLinked')).toBe(true);
    expect([...document.querySelectorAll('.badge-warn')]).toHaveLength(1);

    await click(button('createSupplier'));
    expect(shows('supplierExists')).toBe(true);
    expect(api.mock.calls.some(([path]) => path === '/suppliers/from-carrier/c1')).toBe(false);
    await click(button('linkTo'));
    expect(api).toHaveBeenCalledWith('/suppliers/p9/carriers/c1', { method: 'PUT' });

    matches = [];
    await click(button('createSupplier'));
    expect(api).toHaveBeenCalledWith('/suppliers/from-carrier/c1', { method: 'POST' });
  });
});

describe('warehouse suggestions (D5)', () => {
  const view = (remainingWeightKg: string | null): ShipmentWarehouseDto => ({
    expectedPackages: 10,
    heldPackages: 6,
    remainingPackages: 4,
    balances: [
      {
        warehouseId: 'w1',
        warehouseCode: 'W1',
        nameEn: 'One',
        nameAr: 'One',
        receivedPackages: 4,
        releasedPackages: 0,
        onHandPackages: 4,
        receivedWeightKg: '400',
        releasedWeightKg: '0',
        remainingWeightKg,
      },
      {
        warehouseId: 'w2',
        warehouseCode: 'W2',
        nameEn: 'Two',
        nameAr: 'Two',
        receivedPackages: 2,
        releasedPackages: 0,
        onHandPackages: 2,
        receivedWeightKg: '150',
        releasedWeightKg: '0',
        remainingWeightKg: '150',
      },
    ],
    movements: [],
    actions: {
      canReceive: true,
      canRelease: true,
      canAddPhotos: false,
      canCancelMovements: false,
      receiptStatuses: [],
      defaultReceiptStatus: null,
    },
  });
  const warehouses = [
    { id: 'w1', code: 'W1', nameEn: 'One', nameAr: 'One', isActive: true, storageLocations: [] },
  ];
  const mock = (remaining: string | null) =>
    api.mockImplementation((path: string) =>
      Promise.resolve(path === '/warehouses' ? warehouses : view(remaining)),
    );

  it('offers the packages still to receive; the person confirms them', async () => {
    mock('400');
    await render(<ShipmentWarehouse shipment={shipment()} onShipmentChanged={() => {}} />);
    await click(button('receive'));
    const packages = () => control<HTMLInputElement>('packages');
    expect(packages().value).toBe('');
    await click(button('useRemaining'));
    expect(packages().value).toBe('4');
    expect(shows('remainingSuggested')).toBe(true);
  });

  it("suggests the warehouse's remaining weight for a full release only", async () => {
    mock('400');
    await render(<ShipmentWarehouse shipment={shipment()} onShipmentChanged={() => {}} />);
    await click(button('release'));
    const weight = () => control<HTMLInputElement>('weightKg');
    change(control('packages'), '1');
    expect(weight().value).toBe('');
    change(control('packages'), '4');
    expect(weight().value).toBe('400');
    expect(shows('weightHeldSuggested')).toBe(true);
    // Fewer packages: the suggestion goes.
    change(control('packages'), '3');
    expect(weight().value).toBe('');
    // Another warehouse: its own weight for all it holds, not the first one's.
    change(control('packages'), '4');
    change(control('warehouse'), 'w2');
    expect(weight().value).toBe('');
    change(control('packages'), '2');
    expect(weight().value).toBe('150');
    // A typed weight stays.
    change(weight(), '149');
    change(control('packages'), '1');
    expect(weight().value).toBe('149');
  });

  it('suggests nothing when the remaining weight is not known', async () => {
    mock(null);
    await render(<ShipmentWarehouse shipment={shipment()} onShipmentChanged={() => {}} />);
    await click(button('release'));
    change(control('packages'), '4');
    expect(control<HTMLInputElement>('weightKg').value).toBe('');
  });
});

describe('containers (D4, D5)', () => {
  const consolidation = {
    id: 'k1',
    number: 'NOL-CON-1',
    status: 'CLOSED',
    containerNumber: 'MSCU1234565',
    sealNumber: 'S1',
    containerTypeCode: '40HC',
    canOpen: true,
  } as const;

  it("shows a consolidated LCL shipment's container read-only, keeping its own containers", async () => {
    const own = {
      id: 'x',
      containerNumber: 'OLDU1234560',
      sealNumber: null,
      containerTypeCode: '20GP',
    };
    await render(
      <ShipmentContainers
        shipment={shipment({ loadType: 'LCL', containers: [own] })}
        onChange={() => {}}
        consolidation={consolidation}
      />,
    );
    expect(button('addContainer')).toBeNull();
    expect(shows('MSCU1234565')).toBe(true);
    expect(shows('OLDU1234560')).toBe(true);
  });

  it('defaults the container type only when the booking lines have exactly one', async () => {
    const lines = (codes: (string | null)[]) =>
      codes.map((containerTypeCode, i) => ({ lineNo: i + 1, containerTypeCode, quantity: 1 }));
    await render(
      <ShipmentContainers
        shipment={shipment({ items: lines(['40HC', null, '40HC']) } as Partial<ShipmentDto>)}
        onChange={() => {}}
      />,
    );
    await click(button('addContainer'));
    expect(control<HTMLSelectElement>('containerType').value).toBe('40HC');
    expect(shows('containerTypeFromBooking')).toBe(true);
    act(() => root.unmount());
    document.body.replaceChildren();

    await render(
      <ShipmentContainers
        shipment={shipment({ items: lines(['40HC', '20GP']) } as Partial<ShipmentDto>)}
        onChange={() => {}}
      />,
    );
    await click(button('addContainer'));
    expect(control<HTMLSelectElement>('containerType').value).toBe('');
  });
});

describe('customs file moves the shipment (D1)', () => {
  it('saves the file, then shows the status the API moved the shipment to', async () => {
    const changed = vi.fn();
    api.mockImplementation((path: string, init?: { method: string }) => {
      if (path === '/shipments/s1') return Promise.resolve(shipment({ status: 'CUSTOMS_CLEARED' }));
      if (path === '/shipments/s1/customs/brokers') return Promise.resolve([]);
      if (init?.method === 'PUT') {
        return Promise.resolve({
          clearance: {
            status: 'CLEARED',
            updatedByName: 'x',
            updatedAt: '2026-10-19T08:00:00Z',
          },
          fees: [],
          totals: [],
          actions: { canEdit: true },
        });
      }
      return Promise.resolve({
        clearance: null,
        fees: [],
        totals: [],
        actions: { canEdit: true, canAddFee: false, canRemoveFee: false },
      });
    });
    await render(<ShipmentCustoms shipment={shipment()} onShipmentChange={changed} />);
    await click(button('open'));
    // The manual status buttons stay (none offered here by the state machine).
    expect(shows('movesShipmentHint')).toBe(true);
    const form = document.querySelector('form');
    act(() => {
      form?.requestSubmit();
    });
    await flush();
    expect(api).toHaveBeenCalledWith(
      '/shipments/s1/customs',
      expect.objectContaining({ method: 'PUT' }),
    );
    expect(changed).toHaveBeenCalledWith(expect.objectContaining({ status: 'CUSTOMS_CLEARED' }));
    expect(shows('savedAndMoved')).toBe(true);
  });
});

describe('customs broker and supplier costs (group Z2)', () => {
  const file = (overrides: object = {}) => ({
    clearance: {
      status: 'PENDING',
      declarationNumber: null,
      brokerName: 'Old Broker Co',
      brokerSupplierId: 'sup-old',
      brokerSupplierName: 'Old Broker Co',
      submittedOn: null,
      clearedOn: null,
      note: null,
      updatedByName: 'x',
      updatedAt: '2026-10-19T08:00:00Z',
    },
    fees: [],
    totals: [],
    showsCost: false,
    costLines: null,
    costTotals: null,
    actions: { canEdit: true, canAddFee: false, canRemoveFee: false },
    ...overrides,
  });

  it('picks the broker from the suppliers and keeps a deactivated one selectable', async () => {
    api.mockImplementation((path: string) => {
      if (path === '/shipments/s1/customs/brokers') {
        return Promise.resolve([{ id: 'sup-1', name: 'Port Brokers' }]);
      }
      if (path === '/shipments/s1') return Promise.resolve(shipment());
      return Promise.resolve(file());
    });
    await render(<ShipmentCustoms shipment={shipment()} onShipmentChange={() => {}} />);
    await click(button('edit'));
    const picker = control<HTMLSelectElement>('brokerSupplier');
    // The linked broker is no longer active (not in the list), so it is added and stays selected.
    expect([...picker.options].map((o) => o.value)).toEqual(['', 'sup-old', 'sup-1']);
    expect(picker.value).toBe('sup-old');
    change(picker, 'sup-1');
    act(() => {
      document.querySelector('form')?.requestSubmit();
    });
    await flush();
    expect(api).toHaveBeenCalledWith(
      '/shipments/s1/customs',
      expect.objectContaining({
        method: 'PUT',
        body: expect.objectContaining({ brokerSupplierId: 'sup-1' }) as unknown,
      }),
    );
  });

  it('shows supplier costs apart from the fees only when the user sees costs', async () => {
    api.mockResolvedValue(file());
    await render(<ShipmentCustoms shipment={shipment()} onShipmentChange={() => {}} />);
    expect(shows('supplierCosts')).toBe(false);
    act(() => root.unmount());

    api.mockResolvedValue(
      file({
        showsCost: true,
        costLines: [
          {
            billId: 'b1',
            billNumber: 'NOL-SB-2026-000001',
            billStatus: 'APPROVED',
            billDate: '2026-10-10',
            supplierName: 'Port Brokers',
            supplierReference: 'PB-77',
            fromBroker: true,
            lineNo: 1,
            chargeTypeCode: 'CUSTOMS',
            description: null,
            amount: '250.5',
            currency: 'USD',
          },
        ],
        costTotals: [{ currency: 'USD', amount: '250.5' }],
      }),
    );
    await render(<ShipmentCustoms shipment={shipment()} onShipmentChange={() => {}} />);
    expect(shows('supplierCosts')).toBe(true);
    expect(shows('NOL-SB-2026-000001')).toBe(true);
    expect(shows('fromBroker')).toBe(true);
    expect(shows('approvedTotal')).toBe(true);
    expect(shows('noFees')).toBe(true);
  });
});
