// @vitest-environment jsdom
import type { RevertStepDto, ShipmentStatus } from '@nolon/shared';
import { act } from 'react';
import { type Root, createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => 'en',
}));

const { ShipmentRevertForm } = await import('./ShipmentRevertForm');

const step = (eventId: string, byMe = false): RevertStepDto => ({
  eventId,
  status: 'LOADED',
  occurredAt: '2026-10-27T10:00:00.000Z',
  userName: 'Mohamed',
  byMe,
});

let root: Root | null = null;
let host: HTMLDivElement;

function render(current: RevertStepDto | null, onRevert: (r: string, id: string) => void) {
  const props = {
    to: 'CONSOLIDATED' as ShipmentStatus,
    busy: false,
    onRevert,
    onTooShort: () => undefined,
    onBack: () => undefined,
  };
  act(() => {
    if (!root) {
      host = document.createElement('div');
      document.body.append(host);
      root = createRoot(host);
    }
    root.render(<ShipmentRevertForm step={current} {...props} />);
  });
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
});

const form = () => host.querySelector('form');
const confirmBox = () => host.querySelector<HTMLInputElement>('input[name="confirmOthers"]');

describe('ShipmentRevertForm', () => {
  it('sends the event it was opened on, with a ready reason', () => {
    const onRevert = vi.fn();
    render(step('6'), onRevert);
    act(() => confirmBox()?.click());
    act(() => form()?.requestSubmit());
    expect(onRevert).toHaveBeenCalledWith('revertReason_WRONG_SHIPMENT', '6');
  });

  it('a refresh that brings another step drops the form and its confirmation', () => {
    const onRevert = vi.fn();
    // Opened on the cached preview (event 6) while the refresh is still on its way.
    render(step('6'), onRevert);
    act(() => confirmBox()?.click());
    expect(confirmBox()?.checked).toBe(true);
    // The refresh resolves: event 7 is now the step to undo.
    render(step('7'), onRevert);
    expect(form()).toBeNull();
    expect(confirmBox()).toBeNull();
    expect(host.textContent).toContain('revertTargetChanged');
    // Even if the step went back to 6, this form stays on what it showed and never sends 7.
    render(step('6'), onRevert);
    act(() => form()?.requestSubmit());
    expect(onRevert.mock.calls.every(([, id]) => id === '6')).toBe(true);
  });

  it('asks for confirmation only for another user’s step', () => {
    render(step('8', true), vi.fn());
    expect(confirmBox()).toBeNull();
    expect(form()).not.toBeNull();
  });
});
