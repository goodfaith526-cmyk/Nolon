// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const api = vi.fn();

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, values?: Record<string, string>) =>
    values ? `${key}(${Object.values(values).join(',')})` : key,
}));
vi.mock('@/lib/api', async (actual) => ({
  ...(await actual<typeof import('@/lib/api')>()),
  api: (...args: unknown[]) => api(...args) as unknown,
}));
vi.mock('../commercial/Notice', async (actual) => ({
  ...(await actual<typeof import('../commercial/Notice')>()),
  Notice: () => null,
  useFailureText: () => () => 'failed',
}));

const { ShipmentProfit } = await import('./ShipmentProfit');

const card = {
  rateCardId: 'c1',
  chargeTypeCode: 'FREIGHT',
  currency: 'USD',
  quantity: '1',
  price: '300',
  lines: [],
  expectedMargin: '180',
  incomplete: false,
  missing: [],
  asOf: '2026-10-28',
};

const actual = {
  revenueUsd: '300',
  costUsd: '0',
  marginUsd: '300',
  marginPercent: '100',
  incompleteReasons: ['MISSING_COST'],
  missingCosts: ['MAIN_FREIGHT'],
};

let root: ReturnType<typeof createRoot> | null = null;

async function open(view: object) {
  api.mockReset();
  api.mockResolvedValue(view);
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root?.render(<ShipmentProfit shipmentId="s1" />);
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

afterEach(() => {
  act(() => root?.unmount());
  document.body.replaceChildren();
});

describe('ShipmentProfit (plan 6.2)', () => {
  it('shows the expected and the actual margins side by side, each with its own gaps', async () => {
    await open({
      shipmentId: 's1',
      expected: {
        source: 'QUOTATION',
        cards: [card],
        gaps: [{ chargeTypeCode: 'DOCS', reason: 'NO_CARD' }],
        currency: null,
        expectedMargin: null,
      },
      actual,
    });
    expect(api).toHaveBeenCalledWith('/reports/shipment-profitability/shipments/s1');
    const [expected, posted] = [...document.querySelectorAll('section')].map((s) => s.textContent);
    expect(expected).toContain('source_QUOTATION');
    expect(expected).toContain('180 USD');
    expect(expected).toContain('gap_NO_CARD(DOCS)');
    expect(expected).toContain('expectedIncomplete');
    expect(posted).toContain('300 USD');
    expect(posted).toContain('notFinal_MISSING_COST(service_MAIN_FREIGHT)');
  });

  it('says so when there is no expected margin to show and nothing posted', async () => {
    await open({ shipmentId: 's1', expected: null, actual: null });
    const text = document.body.textContent;
    expect(text).toContain('noExpected');
    expect(text).toContain('nothingPosted');
  });
});
