// @vitest-environment jsdom
import type { CustomerDto, CustomerSummaryDto } from '@nolon/shared';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.fn();
let permissions: string[] = ['customers:create'];

vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }));
vi.mock('@/i18n/navigation', () => ({ Link: () => null, useRouter: () => ({ push: () => {} }) }));
vi.mock('@/lib/api', () => ({ api: (...args: unknown[]) => api(...args) as unknown }));
vi.mock('@/lib/master-data', () => ({
  useMasterData: () => ({ currencies: [] }),
  useLocalName: () => (x: { nameEn?: string }) => x.nameEn ?? '',
}));
vi.mock('../StaffShell', () => ({
  useMe: () => ({ permissions, branches: [{ id: 'b1', nameEn: 'Dubai', nameAr: 'دبي' }] }),
  can: (me: { permissions: string[] }, p: string) => me.permissions.includes(p),
}));
vi.mock('./Notice', () => ({ Notice: () => null, useFailureText: () => () => 'failed' }));

const { CustomerPicker } = await import('./CustomerPicker');

const saved = {
  id: 'c1',
  number: 'CS00009',
  branchId: 'b1',
  kind: 'INDIVIDUAL',
  name: 'Tariq Ismail',
  companyName: null,
  phone: '+249912345678',
  isActive: true,
} as CustomerDto;

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

function buttonByText(text: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll('button')].find((b) => b.textContent === text);
}

function setInput(el: HTMLInputElement, value: string) {
  // React tracks the value it set on the element; only the prototype's setter, called on the
  // element, makes this read as a user's change. It is taken unbound on purpose and applied with
  // the element as `this` just below.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  act(() => {
    setValue?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('CustomerPicker', () => {
  let picked: (CustomerSummaryDto | null)[];
  let outerSubmits: number;
  let root: ReturnType<typeof createRoot>;

  function render(allowCreate: boolean) {
    const host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    act(() => {
      root.render(
        <form
          onSubmit={(e) => {
            e.preventDefault();
            outerSubmits++;
          }}
        >
          <CustomerPicker value={null} onChange={(c) => picked.push(c)} allowCreate={allowCreate} />
        </form>,
      );
    });
  }

  async function searchNothing(text: string) {
    api.mockResolvedValueOnce({ items: [], total: 0, page: 1, pageSize: 20 });
    setInput(document.querySelector('input[type="search"]') as HTMLInputElement, text);
    click(buttonByText('search'));
    await flush();
  }

  beforeEach(() => {
    api.mockReset();
    picked = [];
    outerSubmits = 0;
    permissions = ['customers:create'];
  });
  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
  });

  it('adds a customer the search did not find, picks it, and leaves the outer form alone', async () => {
    render(true);
    await searchNothing('Tariq Ismail');
    expect(document.body.textContent).toContain('customerNotFound');
    click(buttonByText('addNewCustomer'));

    const dialog = document.querySelector('dialog.form-dialog');
    expect(dialog).not.toBeNull();
    // Outside the picker's form: a form inside a form is not valid HTML.
    expect(dialog?.closest('form:not(dialog form)')).toBeNull();
    const name = dialog?.querySelector('input[name="name"]') as HTMLInputElement;
    expect(name.value).toBe('Tariq Ismail');
    setInput(dialog?.querySelector('input[name="phone"]') as HTMLInputElement, '+249912345678');

    api.mockResolvedValueOnce(saved);
    const inner = dialog?.querySelector('form') as HTMLFormElement;
    act(() => {
      inner.requestSubmit();
    });
    await flush();

    expect(api).toHaveBeenLastCalledWith('/customers', {
      method: 'POST',
      body: expect.objectContaining({
        name: 'Tariq Ismail',
        phone: '+249912345678',
        branchId: 'b1',
      }) as unknown,
    });
    expect(picked).toEqual([saved]);
    expect(outerSubmits).toBe(0);
    expect(document.querySelector('dialog.form-dialog')).toBeNull();
  });

  it('offers no new customer without the permission, or where the form does not allow it', async () => {
    permissions = [];
    render(true);
    await searchNothing('x');
    expect(buttonByText('addNewCustomer')).toBeUndefined();
    act(() => root.unmount());
    document.body.replaceChildren();

    permissions = ['customers:create'];
    render(false);
    await searchNothing('x');
    expect(buttonByText('addNewCustomer')).toBeUndefined();
  });

  it('closes the dialog on cancel without picking anything', async () => {
    render(true);
    await searchNothing('x');
    click(buttonByText('addNewCustomer'));
    click(buttonByText('cancel'));
    expect(document.querySelector('dialog.form-dialog')).toBeNull();
    expect(picked).toEqual([]);
    expect(outerSubmits).toBe(0);
  });
});
