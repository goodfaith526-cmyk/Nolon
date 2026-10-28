// @vitest-environment jsdom
import type { ContainerCapacityDto } from '@nolon/shared';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, params?: Record<string, string>) =>
    params ? `${key}(${Object.values(params).join('|')})` : key,
  useLocale: () => 'en',
}));
vi.mock('@/i18n/navigation', () => ({
  Link: ({ children }: { children: unknown }) => children,
}));
vi.mock('../StaffShell', () => ({ useMe: () => ({ permissions: [] }), can: () => false }));
const { CapacityPanel, FillCell, FitNote } = await import('./Capacity');

let host: HTMLElement | null = null;

function show(node: React.ReactNode): HTMLElement {
  host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(node));
  return host;
}

afterEach(() => {
  host?.remove();
  host = null;
});

const capacity: ContainerCapacityDto = {
  volumeCbm: { limit: '28', used: '23', remaining: '5', fillPercent: '82.1', complete: true },
  weightKg: { limit: null, used: '900', remaining: null, fillPercent: null, complete: false },
  incomplete: [{ shipmentId: 's1', shipmentNumber: 'DXB-KRT-0001', missing: ['weightKg'] }],
  asOfNow: false,
};

describe('CapacityPanel', () => {
  it('shows amber from 80 %, no bar without a limit, and the cargo not measured', () => {
    const shown = show(<CapacityPanel capacity={capacity} />);
    const [volume, weight] = shown.querySelectorAll('.capacity');
    expect(volume?.className).toContain('capacity-near');
    expect(volume?.querySelector('[role="meter"]')?.getAttribute('aria-valuenow')).toBe('82.1');
    expect(weight?.querySelector('[role="meter"]')).toBeNull();
    expect(weight?.textContent).toContain('capacityNoLimit(900|unit_weightKg)');
    expect(weight?.textContent).toContain('capacityNotChecked');
    expect(shown.querySelector('.capacity-incomplete')?.textContent).toContain('DXB-KRT-0001');
    expect(shown.textContent).toContain('capacityHint');
  });

  it('says a closed container shows its cargo now, and red at 100 % (bar capped)', () => {
    const full: ContainerCapacityDto = {
      ...capacity,
      volumeCbm: { limit: '28', used: '30', remaining: '-2', fillPercent: '107.1', complete: true },
      asOfNow: true,
    };
    const shown = show(<CapacityPanel capacity={full} />);
    const volume = shown.querySelector('.capacity');
    expect(volume?.className).toContain('capacity-full');
    expect(volume?.querySelector('[role="meter"]')?.getAttribute('aria-valuenow')).toBe('100');
    expect(shown.textContent).toContain('capacityAsOfNow');
  });
});

describe('FillCell and FitNote', () => {
  it('shows the fill with "incomplete", and a dash without a limit', () => {
    expect(show(<FillCell fillPercent="45.0" fillIncomplete />).textContent).toBe(
      '45.0% · capacityIncompleteShort',
    );
    host?.remove();
    expect(show(<FillCell fillPercent={null} fillIncomplete={false} />).textContent).toBe('—');
  });

  it('names what a shipment would exceed, or what is left', () => {
    const base = {
      shipmentId: 's1',
      volumeCbm: '3',
      weightKg: '100',
      remainingVolumeCbm: '2',
      remainingWeightKg: null,
    };
    expect(
      show(<FitNote fit={{ ...base, fits: false, over: ['volumeCbm'], unchecked: [] }} />)
        .textContent,
    ).toBe('fitOver(capacity_volumeCbm)');
    host?.remove();
    expect(
      show(<FitNote fit={{ ...base, fits: true, over: [], unchecked: ['weightKg'] }} />)
        .textContent,
    ).toBe('fitLeft(2 unit_volumeCbm) · fitUnchecked(capacity_weightKg)');
  });
});
