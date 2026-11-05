// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DropOffSelect } from './DropOffSelect';

const api = vi.fn();
vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }));
vi.mock('@/lib/api', () => ({ api: (...args: unknown[]) => api(...args) as unknown }));
vi.mock('@/lib/master-data', () => ({
  useLocalName: () => (x: { nameEn: string }) => x.nameEn,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  api.mockReset();
});

async function render(value: string, heldCode: string | null = null) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <DropOffSelect branchId="b1" value={value} onChange={() => {}} heldCode={heldCode} />,
    );
  });
  return host;
}

/** Plan 13 section 1: the booking form's window field. */
describe('DropOffSelect', () => {
  it("lists the branch's windows, each labelled with the outlet that runs it", async () => {
    api.mockResolvedValue([
      { id: 'w1', branchId: 'b1', code: 'W1', nameAr: '', nameEn: 'Safa', outletName: 'Agency X' },
      { id: 'w2', branchId: 'b1', code: 'W2', nameAr: '', nameEn: 'Hub', outletName: null },
    ]);
    const el = await render('');
    expect(api).toHaveBeenCalledWith('/bookings/drop-off-points?branchId=b1');
    expect([...el.querySelectorAll('option')].map((o) => o.textContent)).toEqual([
      'dropOffNone',
      'Safa (W1) · Agency X',
      'Hub (W2)',
    ]);
  });

  it('hides itself when the branch has none or the list is refused, unless one is held', async () => {
    api.mockRejectedValue(new Error('403'));
    expect((await render('')).querySelector('select')).toBeNull();
    act(() => root?.unmount());
    host?.remove();
    const held = await render('w9', 'W9');
    expect([...held.querySelectorAll('option')].map((o) => o.textContent)).toEqual([
      'dropOffNone',
      'W9',
    ]);
  });
});
