// @vitest-environment jsdom
import type { AccountDto, CustomerInvoiceSummaryDto, CustomerSummaryDto } from '@nolon/shared';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.fn();
const DUBAI = {
  id: 'b1',
  code: 'DXB',
  nameEn: 'Dubai',
  today: '2026-10-19',
  defaultCurrency: 'AED',
};
const JEDDAH = {
  id: 'b2',
  code: 'JED',
  nameEn: 'Jeddah',
  today: '2026-10-20',
  defaultCurrency: 'SAR',
};
// Stable across renders, as the real hooks are: effects depend on them.
const ME = { permissions: ['*'], allBranches: false, branches: [DUBAI, JEDDAH] };
const failed = () => 'failed';
const CUSTOMER = { id: 'c1', branchId: 'b2', name: 'Tariq', number: 'C1' } as CustomerSummaryDto;

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => 'en',
}));
vi.mock('@/i18n/navigation', () => ({ Link: () => null, useRouter: () => ({ push: () => {} }) }));
vi.mock('@/lib/api', async (actual) => ({
  ...(await actual<typeof import('@/lib/api')>()),
  api: (...args: unknown[]) => api(...args) as unknown,
}));
vi.mock('@/lib/master-data', async (actual) => ({
  ...(await actual<typeof import('@/lib/master-data')>()),
  useMasterData: () => ({
    branches: [DUBAI, JEDDAH],
    currencies: ['AED', 'EUR', 'SAR', 'USD'].map((code) => ({
      code,
      nameEn: code,
      isActive: true,
    })),
    locations: [],
    chargeTypes: [],
  }),
  useLocalName: () => (x: { nameEn?: string }) => x.nameEn ?? '',
}));
vi.mock('../StaffShell', () => ({
  useMe: () => ME,
  can: () => true,
}));
vi.mock('../commercial/Notice', async (actual) => ({
  ...(await actual<typeof import('../commercial/Notice')>()),
  Notice: () => null,
  useFailureText: () => failed,
}));
vi.mock('../commercial/CustomerPicker', () => ({
  CustomerPicker: ({ onChange }: { onChange: (c: CustomerSummaryDto) => void }) => (
    <button type="button" id="pick-customer" onClick={() => onChange(CUSTOMER)} />
  ),
}));

const { ExpenseForm } = await import('./ExpenseForm');
const { ReceiptForm } = await import('./ReceiptForm');
const { JournalForm } = await import('./JournalForm');
const { Accounts } = await import('./Accounts');
const { CreditNoteFields } = await import('./CreditNoteDetail');
const { FxRates } = await import('./FxRates');
const { TripForm } = await import('../transport/TripForm');
const { SupplierPaymentForm } = await import('../payables/SupplierPaymentForm');

const account = (overrides: Partial<AccountDto>): AccountDto => ({
  id: 'a',
  code: '1000',
  nameEn: 'Account',
  nameAr: 'حساب',
  type: 'ASSET',
  parentId: null,
  isPostable: true,
  isCash: false,
  currency: null,
  branchId: null,
  isActive: true,
  isControl: false,
  ...overrides,
});
const cashAed = account({ id: 'cash-aed', code: '1101', isCash: true, currency: 'AED' });
const cashSar = account({ id: 'cash-sar', code: '1102', isCash: true, currency: 'SAR' });
const cashSar2 = account({ id: 'cash-sar2', code: '1103', isCash: true, currency: 'SAR' });
const rent = account({ id: 'rent', code: '5100', type: 'EXPENSE' });
const expenses = account({ id: 'exp', code: '5000', type: 'EXPENSE', isPostable: false });
let accounts: AccountDto[] = [];
let invoices: Partial<CustomerInvoiceSummaryDto>[] = [];

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

function click(el: Element | null) {
  act(() => {
    (el as HTMLElement).click();
  });
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

let root: ReturnType<typeof createRoot>;

async function render(node: React.ReactNode) {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root.render(node));
  await flush();
}

beforeEach(() => {
  api.mockReset();
  accounts = [cashAed, cashSar, rent, expenses];
  invoices = [];
  api.mockImplementation((path: string) => {
    if (path === '/accounting/accounts') return Promise.resolve(accounts);
    if (path.startsWith('/customer-invoices')) return Promise.resolve({ items: invoices });
    if (path.startsWith('/receipts/allocation-suggestion')) {
      return Promise.resolve({
        allocations: [{ invoiceId: 'i1', amount: '40' }],
        unallocated: '5',
      });
    }
    if (path.startsWith('/transport/')) return Promise.resolve([]);
    if (path === '/accounting/expense-categories') return Promise.resolve([]);
    if (path === '/accounting/settings') return Promise.resolve({ mappings: [], chargeTypes: [] });
    if (path.startsWith('/accounting/fx-rates')) return Promise.resolve([]);
    return Promise.resolve({ items: [] });
  });
});
afterEach(() => {
  act(() => root.unmount());
  document.body.replaceChildren();
});

describe('expense and supplier payment (functional review C4, C9)', () => {
  it("starts in the branch's currency, date and only cash account, and follows the branch", async () => {
    await render(<ExpenseForm />);
    expect(control<HTMLSelectElement>('currency').value).toBe('AED');
    expect(control<HTMLInputElement>('expenseDate').value).toBe('2026-10-19');
    expect(control<HTMLSelectElement>('cashAccount').value).toBe('cash-aed');

    change(control('branch'), 'b2');
    expect(control<HTMLSelectElement>('currency').value).toBe('SAR');
    expect(control<HTMLInputElement>('expenseDate').value).toBe('2026-10-20');
    expect(control<HTMLSelectElement>('cashAccount').value).toBe('cash-sar');
  });

  it('keeps a currency and a date the person chose, and drops a cash account that no longer matches', async () => {
    accounts = [cashAed, cashSar, cashSar2];
    await render(<ExpenseForm />);
    change(control('branch'), 'b2');
    // Two SAR accounts: none is taken for the person.
    expect(control<HTMLSelectElement>('cashAccount').value).toBe('');
    change(control('cashAccount'), 'cash-sar2');
    change(control('expenseDate'), '2026-10-01');
    change(control('currency'), 'AED');
    expect(control<HTMLSelectElement>('cashAccount').value).toBe('cash-aed');
    change(control('branch'), 'b1');
    expect(control<HTMLSelectElement>('currency').value).toBe('AED');
    expect(control<HTMLInputElement>('expenseDate').value).toBe('2026-10-01');
  });

  it("starts a supplier payment in the branch's currency and today", async () => {
    await render(<SupplierPaymentForm />);
    expect(control<HTMLSelectElement>('currency').value).toBe('AED');
    expect(control<HTMLInputElement>('paymentDate').value).toBe('2026-10-19');
    expect(control<HTMLSelectElement>('cashAccount').value).toBe('cash-aed');
    change(control('branch'), 'b2');
    expect(control<HTMLSelectElement>('currency').value).toBe('SAR');
    expect(control<HTMLInputElement>('paymentDate').value).toBe('2026-10-20');
  });
});

describe('receipt (functional review C3, C9)', () => {
  const invoice = (id: string, currency: string, balance: string) => ({
    id,
    number: id,
    currency,
    balance,
    total: balance,
    invoiceDate: '2026-10-01',
    dueDate: '2026-10-01',
    shipmentNumber: null,
  });

  it("suggests the open invoices' one currency and the customer's branch today", async () => {
    invoices = [invoice('i1', 'SAR', '40'), invoice('i2', 'SAR', '60')];
    await render(<ReceiptForm />);
    expect(control<HTMLSelectElement>('currency').value).toBe('');
    click(document.querySelector('#pick-customer'));
    await flush();
    expect(control<HTMLSelectElement>('currency').value).toBe('SAR');
    expect(control<HTMLInputElement>('receiptDate').value).toBe('2026-10-20');
    expect(control<HTMLSelectElement>('cashAccount').value).toBe('cash-sar');
  });

  it('suggests no currency when the invoices are in several', async () => {
    invoices = [invoice('i1', 'SAR', '40'), invoice('i2', 'USD', '60')];
    await render(<ReceiptForm />);
    click(document.querySelector('#pick-customer'));
    await flush();
    expect(control<HTMLSelectElement>('currency').value).toBe('');
    expect(document.body.textContent).toContain('mixedCurrencies');
  });

  it('fills a balance only when asked, and the split from the API', async () => {
    invoices = [invoice('i1', 'SAR', '40'), invoice('i2', 'SAR', '60')];
    await render(<ReceiptForm />);
    click(document.querySelector('#pick-customer'));
    await flush();
    const shares = () =>
      [...document.querySelectorAll<HTMLInputElement>('input.amount-input')].map((i) => i.value);
    expect(shares()).toEqual(['', '']);
    click(document.querySelectorAll('tbody button')[1] ?? null);
    expect(shares()).toEqual(['', '60']);

    change(control('amount'), '45');
    click(button('distribute'));
    await flush();
    expect(api).toHaveBeenCalledWith(
      '/receipts/allocation-suggestion?customerId=c1&currency=SAR&amount=45',
    );
    expect(shares()).toEqual(['40', '']);
    expect(document.body.textContent).toContain('distributedRest');
  });
});

describe('external trip (functional review C5)', () => {
  it("starts in the branch's currency, which stays choosable", async () => {
    await render(<TripForm />);
    click(document.querySelector('input[value="EXTERNAL"]'));
    const currency = () => document.querySelector<HTMLSelectElement>('select[name="currency"]');
    expect(currency()?.value).toBe('AED');
    change(control('branch'), 'b2');
    expect(currency()?.value).toBe('SAR');
    change(currency() as HTMLSelectElement, 'USD');
    change(control('branch'), 'b1');
    expect(currency()?.value).toBe('USD');
  });
});

describe('manual journal (functional review C6, C9)', () => {
  it("sets a line's currency from a cash account, not from another account", async () => {
    await render(<JournalForm />);
    expect(control<HTMLInputElement>('entryDate').value).toBe('2026-10-19');
    const lineCurrency = () => control<HTMLSelectElement>('currency');
    expect(lineCurrency().value).toBe('USD');
    change(control('account'), 'cash-sar');
    expect(lineCurrency().value).toBe('SAR');
    change(control('account'), 'rent');
    expect(lineCurrency().value).toBe('SAR');
    change(lineCurrency(), 'EUR');
    change(control('account'), 'cash-aed');
    expect(lineCurrency().value).toBe('AED');
  });
});

describe('chart of accounts (functional review C7)', () => {
  it("locks the type to the parent's, and a root account chooses it", async () => {
    await render(<Accounts />);
    click(button('add'));
    const type = () => control<HTMLSelectElement>('type');
    change(type(), 'REVENUE');
    change(control('parent'), 'exp');
    expect(type().value).toBe('EXPENSE');
    expect(type().disabled).toBe(true);
    change(control('parent'), '');
    expect(type().value).toBe('REVENUE');
    expect(type().disabled).toBe(false);
  });
});

describe('credit note (functional review C8)', () => {
  it('leaves the amount empty until "full balance" is pressed', async () => {
    await render(
      <form>
        <CreditNoteFields currency="SAR" defaultDate="2026-10-19" fullBalance="125.5" />
      </form>,
    );
    const amount = document.querySelector<HTMLInputElement>('input[name="amount"]');
    expect(amount?.value).toBe('');
    click(button('fullBalance'));
    expect(amount?.value).toBe('125.5');
  });
});

describe('exchange rates (functional review C9)', () => {
  it('dates a rate today in the branches of its currency, until a date is typed', async () => {
    await render(<FxRates />);
    const date = () => document.querySelector<HTMLInputElement>('input[name="rateDate"]');
    const currency = () => document.querySelector<HTMLSelectElement>('select[name="currency"]');
    // AED: Dubai's today.
    expect(currency()?.value).toBe('AED');
    expect(date()?.value).toBe('2026-10-19');
    change(currency() as HTMLSelectElement, 'SAR');
    expect(date()?.value).toBe('2026-10-20');
    // EUR: no branch works in it, and the branches disagree on the day.
    change(currency() as HTMLSelectElement, 'EUR');
    expect(date()?.value).toBe('');
    change(date() as HTMLInputElement, '2026-10-05');
    change(currency() as HTMLSelectElement, 'AED');
    expect(date()?.value).toBe('2026-10-05');
  });
});
