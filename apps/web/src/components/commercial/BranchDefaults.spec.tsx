// @vitest-environment jsdom
import type { CustomerDto } from '@nolon/shared';
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
let branches = [DUBAI];

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
    locations: [
      { id: 'l1', code: 'JEA', kind: 'PORT', nameEn: 'Jebel Ali', isActive: true },
      { id: 'l2', code: 'PZU', kind: 'PORT', nameEn: 'Port Sudan', isActive: true },
    ],
    containerTypes: [{ code: '20GP', nameEn: '20GP', isActive: true }],
    chargeTypes: [{ code: 'FREIGHT', nameEn: 'Freight', isActive: true }],
  }),
  useLocalName: () => (x: { nameEn?: string }) => x.nameEn ?? '',
}));
vi.mock('../StaffShell', () => ({
  useMe: () => ({ permissions: ['*'], allBranches: false, branches }),
  can: () => true,
}));
vi.mock('./Notice', async (actual) => ({
  ...(await actual<typeof import('./Notice')>()),
  Notice: () => null,
  useFailureText: () => () => 'failed',
}));

const { CustomerForm } = await import('./Customers');
const { Rates } = await import('./Rates');
const { ConsolidationForm } = await import('../consolidations/ConsolidationForm');

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

const byName = <T extends Element>(name: string) => document.querySelector<T>(`[name="${name}"]`);
const branchLabel = () =>
  [...document.querySelectorAll('label.field')].find((l) => l.textContent?.startsWith('branch'));

let root: ReturnType<typeof createRoot>;
async function render(node: React.ReactNode) {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root.render(node);
  });
  await flush();
}

beforeEach(() => {
  api.mockReset();
  api.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 100 });
  branches = [DUBAI];
});
afterEach(() => {
  act(() => root.unmount());
  document.body.replaceChildren();
});

describe('one branch: no branch to choose (functional review B7)', () => {
  it('customer form sends the only branch without asking; two branches are asked', async () => {
    await render(<CustomerForm onCancel={() => {}} onSaved={() => {}} />);
    expect(byName('branchId')).toBeNull();
    change(byName<HTMLInputElement>('name') as HTMLInputElement, 'Tariq');
    change(byName<HTMLInputElement>('phone') as HTMLInputElement, '+249912345678');
    api.mockResolvedValueOnce({ id: 'c1' });
    act(() => {
      (document.querySelector('form') as HTMLFormElement).requestSubmit();
    });
    await flush();
    expect(api).toHaveBeenCalledWith('/customers', {
      method: 'POST',
      body: expect.objectContaining({ branchId: 'b1' }) as unknown,
    });

    act(() => root.unmount());
    document.body.replaceChildren();
    branches = [DUBAI, JEDDAH];
    await render(<CustomerForm onCancel={() => {}} onSaved={() => {}} />);
    expect(byName<HTMLSelectElement>('branchId')?.value).toBe('b1');
  });

  it('rate form and container form hide the branch with one', async () => {
    await render(<Rates />);
    act(() => {
      [...document.querySelectorAll('button')].find((b) => b.textContent === 'add')?.click();
    });
    expect(byName('branchId')).toBeNull();
    act(() => root.unmount());
    document.body.replaceChildren();

    await render(<ConsolidationForm />);
    expect(branchLabel()).toBeUndefined();
    act(() => root.unmount());
    document.body.replaceChildren();

    branches = [DUBAI, JEDDAH];
    await render(<ConsolidationForm />);
    expect(branchLabel()).toBeDefined();
  });
});

describe("rate card valid-from is the branch's today (functional review B4)", () => {
  it("follows the chosen branch's today until a date is typed", async () => {
    branches = [DUBAI, JEDDAH];
    await render(<Rates />);
    act(() => {
      [...document.querySelectorAll('button')].find((b) => b.textContent === 'add')?.click();
    });
    const validFrom = () => byName<HTMLInputElement>('validFrom') as HTMLInputElement;
    expect(validFrom().value).toBe('2026-10-19');
    change(byName<HTMLSelectElement>('branchId') as HTMLSelectElement, 'b2');
    expect(validFrom().value).toBe('2026-10-20');
    change(validFrom(), '2026-12-01');
    change(byName<HTMLSelectElement>('branchId') as HTMLSelectElement, 'b1');
    expect(validFrom().value).toBe('2026-12-01');
  });
});

describe('credit limit currency (functional review B8)', () => {
  const creditCurrency = () =>
    byName<HTMLSelectElement>('creditLimitCurrency') as HTMLSelectElement;

  it("a new limit follows the preferred currency, else the branch's, until one is picked", async () => {
    await render(<CustomerForm onCancel={() => {}} onSaved={() => {}} />);
    expect(creditCurrency().value).toBe('AED');
    change(byName<HTMLSelectElement>('preferredCurrency') as HTMLSelectElement, 'EUR');
    expect(creditCurrency().value).toBe('EUR');
    change(creditCurrency(), 'USD');
    change(byName<HTMLSelectElement>('preferredCurrency') as HTMLSelectElement, 'SAR');
    expect(creditCurrency().value).toBe('USD');
  });

  it('a typed limit keeps its currency when the preferred currency changes (Codex F93-2)', async () => {
    await render(<CustomerForm onCancel={() => {}} onSaved={() => {}} />);
    change(byName<HTMLSelectElement>('preferredCurrency') as HTMLSelectElement, 'EUR');
    expect(creditCurrency().value).toBe('EUR');
    change(byName<HTMLInputElement>('creditLimit') as HTMLInputElement, '100');
    change(byName<HTMLSelectElement>('preferredCurrency') as HTMLSelectElement, 'SAR');
    expect(creditCurrency().value).toBe('EUR');
    expect(byName<HTMLInputElement>('creditLimit')?.value).toBe('100');
  });

  it('an existing limit keeps its currency; an empty one takes the preferred currency', async () => {
    const existing = {
      id: 'c1',
      branchId: 'b1',
      kind: 'COMPANY',
      name: 'Tariq',
      phone: '+249912345678',
      preferredCurrency: 'EUR',
      preferredLocale: 'ar',
      paymentTermsDays: 0,
      creditLimit: '5000',
      creditLimitCurrency: 'USD',
    } as unknown as CustomerDto;
    await render(<CustomerForm customer={existing} onCancel={() => {}} onSaved={() => {}} />);
    expect(creditCurrency().value).toBe('USD');
    change(byName<HTMLSelectElement>('preferredCurrency') as HTMLSelectElement, 'SAR');
    expect(creditCurrency().value).toBe('USD');
    act(() => root.unmount());
    document.body.replaceChildren();

    await render(
      <CustomerForm
        customer={{ ...existing, creditLimit: null, creditLimitCurrency: null }}
        onCancel={() => {}}
        onSaved={() => {}}
      />,
    );
    expect(creditCurrency().value).toBe('EUR');
  });
});
