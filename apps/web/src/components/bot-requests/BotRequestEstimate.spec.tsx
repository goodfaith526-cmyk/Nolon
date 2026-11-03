// @vitest-environment jsdom
import type { CsBookingRequestStaffDto, MasterDataDto } from '@nolon/shared';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }));
vi.mock('@/lib/master-data', () => ({
  isPlace: () => true,
  useLocalName: () => (l: { nameEn: string }) => l.nameEn,
}));
vi.mock('../commercial/ModePicker', () => ({ ModePicker: () => null }));
const { BotRequestEstimate } = await import('./BotRequestEstimate');

const master = {
  locations: [
    { id: 'jed', code: 'JED', nameEn: 'Jeddah', isActive: true },
    { id: 'krt', code: 'KRT', nameEn: 'Khartoum', isActive: true },
  ],
  currencies: [{ code: 'USD', isActive: true }],
} as unknown as MasterDataDto;

let host: HTMLElement | null = null;
afterEach(() => {
  host?.remove();
  host = null;
});

describe('BotRequestEstimate', () => {
  it('sends the route and mode the estimate prices with it (Codex F171-2)', async () => {
    const sent = vi.fn();
    host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const request = {
      version: 3,
      originId: 'jed',
      destinationId: 'krt',
      estimate: null,
      actions: { canEstimate: true },
    } as unknown as CsBookingRequestStaffDto;
    act(() =>
      root.render(
        <BotRequestEstimate request={request} master={master} busy={false} onEstimate={sent} />,
      ),
    );
    const form = host.querySelector('form')!;
    const input = (name: string, value: string) => {
      const el = form.querySelector<HTMLInputElement | HTMLSelectElement>(`[name="${name}"]`)!;
      el.value = value;
    };
    input('amount', '120');
    input('currency', 'USD');
    input('validUntil', '2030-01-01T10:00');
    await act(async () => {
      form.requestSubmit();
      await Promise.resolve();
    });
    expect(sent).toHaveBeenCalledWith(
      expect.objectContaining({
        version: 3,
        amount: '120',
        currency: 'USD',
        terms: { originId: 'jed', destinationId: 'krt', mode: 'SEA' },
      }),
    );
    act(() => root.unmount());
  });
});
