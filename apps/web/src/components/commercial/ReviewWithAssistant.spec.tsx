// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api';

const api = vi.fn();
let assistantUrl: string | null = 'https://agent.example/?tenant=nolon';

vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }));
vi.mock('@/lib/api', async (actual) => ({
  ...(await actual<typeof import('@/lib/api')>()),
  api: (...args: unknown[]) => api(...args) as unknown,
}));
vi.mock('../StaffShell', () => ({ useMe: () => ({ assistantUrl }) }));

const { ReviewWithAssistant, assistantReviewUrl, refusedForm } =
  await import('./ReviewWithAssistant');

const form = {
  form: 'booking' as const,
  mode: 'create' as const,
  values: { items: [{ weightKg: '12٬5' }] },
  customerName: 'Tariq',
};

describe('what a refused save keeps for the assistant', () => {
  it('keeps refused input and conflicts, with the fields NOLON named', () => {
    const refused = refusedForm(new ApiError(400, 'items.0.weightKg', ['items.0.weightKg']), form);
    expect(refused).toEqual({
      ...form,
      invalidFields: ['items.0.weightKg'],
      reason: 'items.0.weightKg',
    });
    expect(refusedForm(new ApiError(409, 'Customer is inactive'), form)?.reason).toBe(
      'Customer is inactive',
    );
  });

  it('offers nothing for a missing permission, a lost connection or anything else', () => {
    expect(refusedForm(new ApiError(403, 'Forbidden'), form)).toBeNull();
    expect(refusedForm(new ApiError(500, 'Internal'), form)).toBeNull();
    expect(refusedForm(new TypeError('Failed to fetch'), form)).toBeNull();
  });

  it('opens the assistant with the kept form in the fragment, keeping its query', () => {
    expect(assistantReviewUrl('https://agent.example/?tenant=nolon', 'r1')).toBe(
      'https://agent.example/?tenant=nolon#review=r1',
    );
  });
});

describe('Review with the assistant', () => {
  let container: HTMLDivElement;
  const refused = { ...form, invalidFields: ['items.0.weightKg'], reason: 'x' };

  beforeEach(() => {
    api.mockReset();
    assistantUrl = 'https://agent.example/?tenant=nolon';
    container = document.createElement('div');
    document.body.append(container);
  });
  afterEach(() => {
    container.remove();
    vi.restoreAllMocks();
  });

  function render(props: Parameters<typeof ReviewWithAssistant>[0]) {
    const root = createRoot(container);
    act(() => root.render(<ReviewWithAssistant {...props} />));
  }

  async function click() {
    await act(async () => {
      container.querySelector('button')?.click();
      await new Promise((r) => setTimeout(r, 0));
    });
  }

  it('shows nothing without a refused save or without an assistant', () => {
    render({ refused: null });
    expect(container.querySelector('button')).toBeNull();
    assistantUrl = null;
    render({ refused });
    expect(container.querySelector('button')).toBeNull();
  });

  it('keeps the form, then opens the assistant on it in the tab opened by the click', async () => {
    const tab = { opener: {}, location: { href: '' }, close: vi.fn() };
    const open = vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
    api.mockResolvedValue({ id: 'r1' });
    render({ refused });
    await click();
    expect(open).toHaveBeenCalledWith('about:blank', '_blank');
    expect(tab.opener).toBeNull();
    expect(api).toHaveBeenCalledWith('/assistant-form-reviews', { method: 'POST', body: refused });
    expect(tab.location.href).toBe('https://agent.example/?tenant=nolon#review=r1');
  });

  it('gives a link when the browser blocked the tab', async () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    api.mockResolvedValue({ id: 'r1' });
    render({ refused });
    await click();
    expect(container.querySelector('a')?.getAttribute('href')).toBe(
      'https://agent.example/?tenant=nolon#review=r1',
    );
  });

  it('closes the tab and says so when the form could not be kept', async () => {
    const tab = { opener: {}, location: { href: '' }, close: vi.fn() };
    vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
    api.mockRejectedValue(new ApiError(403, 'Forbidden'));
    render({ refused });
    await click();
    expect(tab.close).toHaveBeenCalled();
    expect(container.textContent).toContain('reviewWithAssistantFailed');
  });
});
