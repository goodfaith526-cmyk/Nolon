// @vitest-environment jsdom
import type { ShipmentDto, ShipmentItemDto } from '@nolon/shared';
import { act } from 'react';
import { type Root, createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const api = vi.fn();

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => 'en',
}));
vi.mock('@/lib/api', async (actual) => ({
  ...(await actual<typeof import('@/lib/api')>()),
  api: (...args: unknown[]) => api(...args) as unknown,
}));
vi.mock('@/lib/master-data', async (actual) => ({
  ...(await actual<typeof import('@/lib/master-data')>()),
  useMasterData: () => ({ containerTypes: [{ code: '20GP', isActive: true }] }),
  useLocalName: () => (x: { nameEn?: string }) => x.nameEn ?? '',
}));

const { ShipmentCargo } = await import('./ShipmentCargo');

const line: ShipmentItemDto = {
  lineNo: 1,
  cargoType: 'GENERAL',
  containerTypeCode: null,
  description: null,
  quantity: 2,
  lengthCm: null,
  widthCm: null,
  heightCm: null,
  weightKg: '40',
  volumeCbm: '1.5',
};

const shipment = (canCorrectCargo: boolean): ShipmentDto =>
  ({
    id: 's1',
    items: [line],
    cargoRevision: 3,
    cargoCorrections: [],
    actions: { canCorrectCargo },
  }) as unknown as ShipmentDto;

let root: Root | null = null;
let host: HTMLDivElement;

function render(s: ShipmentDto, onChange: (s: ShipmentDto) => void = () => undefined) {
  act(() => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    root.render(<ShipmentCargo shipment={s} onChange={onChange} />);
  });
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
  api.mockReset();
});

const correctButton = () =>
  [...host.querySelectorAll('button')].find((b) => b.textContent === 'correctCargo');

describe('ShipmentCargo', () => {
  it('offers the correction only when the API allows it', () => {
    render(shipment(false));
    expect(correctButton()).toBeUndefined();
    act(() => root?.unmount());
    host.remove();
    render(shipment(true));
    expect(correctButton()).toBeDefined();
  });

  it('sends every line with the revision it was opened on and one request id per attempt', async () => {
    api.mockRejectedValueOnce(new Error('refused'));
    api.mockResolvedValueOnce(shipment(true));
    render(shipment(true));
    act(() => correctButton()?.click());
    const reason = host.querySelector('textarea');
    if (!reason) throw new Error('No reason field');
    act(() => {
      // eslint-disable-next-line @typescript-eslint/unbound-method -- applied with the element as `this` below
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      set?.call(reason, 'Weighed again');
      reason.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const submit = async () => {
      await act(async () => {
        host.querySelector('form')?.requestSubmit();
        await Promise.resolve();
      });
    };
    await submit();
    await submit();
    expect(api).toHaveBeenCalledTimes(2);
    const [path, options] = api.mock.calls[0] as [string, { method: string; body: object }];
    expect(path).toBe('/shipments/s1/items');
    expect(options.method).toBe('PUT');
    expect(options.body).toMatchObject({
      expectedRevision: 3,
      reason: 'Weighed again',
      items: [{ cargoType: 'GENERAL', quantity: 2, weightKg: '40', volumeCbm: '1.5' }],
    });
    // A retry of the same attempt keeps its request id.
    const second = api.mock.calls[1] as [string, { body: { requestId: string } }];
    expect(second[1].body.requestId).toBe((options.body as { requestId: string }).requestId);
  });
});
