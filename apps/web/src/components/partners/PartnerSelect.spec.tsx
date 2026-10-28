// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const api = vi.fn();

vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }));
vi.mock('@/lib/api', () => ({ api: (...args: unknown[]) => api(...args) as unknown }));

const { PartnerSelect, partnerChange } = await import('./PartnerSelect');

const held = { id: 'p-old', number: 'NOL-PTR-000001', name: 'Old outlet', isActive: false };
const listed = (id: string, name: string) => ({ id, number: `N-${id}`, name, isActive: true });

async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe('partnerChange', () => {
  it('sends nothing while the choice is the one held, else the new one or null', () => {
    expect(partnerChange(held, 'p-old')).toBeUndefined();
    expect(partnerChange(null, '')).toBeUndefined();
    expect(partnerChange(held, 'p-new')).toBe('p-new');
    expect(partnerChange(held, '')).toBeNull();
    expect(partnerChange(null, 'p-new')).toBe('p-new');
  });
});

describe('PartnerSelect', () => {
  let root: ReturnType<typeof createRoot> | null = null;
  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    document.body.replaceChildren();
    api.mockReset();
  });

  async function show(branchIds: string[]) {
    const host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    act(() => {
      root?.render(
        <PartnerSelect
          kind="DISTRIBUTOR"
          branchIds={branchIds}
          held={held}
          value="p-old"
          onChange={() => {}}
        />,
      );
    });
    await flush();
    return host.querySelector('select') as HTMLSelectElement;
  }

  it('lists the active partners of the kind of each branch, and the one held', async () => {
    api.mockImplementation((path: string) =>
      Promise.resolve({
        items: path.includes('branchId=b1') ? [listed('p1', 'One')] : [listed('p2', 'Two')],
      }),
    );
    const select = await show(['b1', 'b2']);
    expect(api.mock.calls.map((c) => c[0] as string)).toEqual([
      '/partners?kind=DISTRIBUTOR&branchId=b1&isActive=true&pageSize=100',
      '/partners?kind=DISTRIBUTOR&branchId=b2&isActive=true&pageSize=100',
    ]);
    expect([...select.options].map((o) => o.value)).toEqual(['', 'p-old', 'p1', 'p2']);
    expect(select.options[1]?.textContent).toContain('inactivePartner');
    expect(select.value).toBe('p-old');
  });

  it('offers only the one held when the list cannot be read, and asks nothing without a branch', async () => {
    api.mockRejectedValue(new Error('403'));
    expect([...(await show(['b1'])).options].map((o) => o.value)).toEqual(['', 'p-old']);
    act(() => root?.unmount());
    api.mockReset();
    await show([]);
    expect(api).not.toHaveBeenCalled();
  });
});
