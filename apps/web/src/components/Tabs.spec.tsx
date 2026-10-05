// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { serverRenderThenHydrate } from '@/test/hydrate';
import { Tabs } from './Tabs';

const tabs = [
  { key: 'overview', label: 'Overview', content: <p>overview panel</p> },
  { key: 'containers', label: 'Containers', content: <p>containers panel</p> },
  { key: 'invoices', label: 'Invoices', content: <p>invoices panel</p> },
];

const ui = () => <Tabs tabs={tabs} label="Sections" />;

function selectedTab(container: HTMLElement): string | null | undefined {
  return container.querySelector('[role="tab"][aria-selected="true"]')?.textContent;
}

function visiblePanel(container: HTMLElement): string | null | undefined {
  return container.querySelector('[role="tabpanel"]:not([hidden])')?.textContent;
}

function press(container: HTMLElement, key: string) {
  const list = container.querySelector('[role="tablist"]');
  act(() => {
    list?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });
}

describe('Tabs', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '/');
    document.documentElement.dir = 'ltr';
  });
  afterEach(() => {
    document.body.replaceChildren();
  });

  it('opens the tab named in the hash after a reload, without hydration warnings', async () => {
    const page = await serverRenderThenHydrate(ui, () =>
      window.history.replaceState(null, '', '/#containers'),
    );
    expect(page.problems).toEqual([]);
    expect(selectedTab(page.container)).toBe('Containers');
    expect(visiblePanel(page.container)).toBe('containers panel');
    page.unmount();
  });

  it('falls back to the first tab for an unknown or malformed hash', async () => {
    for (const hash of ['#nope', '#%E0%A4%A', '#']) {
      const page = await serverRenderThenHydrate(ui, () =>
        window.history.replaceState(null, '', `/${hash}`),
      );
      expect(page.problems).toEqual([]);
      expect(selectedTab(page.container)).toBe('Overview');
      page.unmount();
    }
  });

  it('follows the hash when it changes (a link or Back on the same page)', async () => {
    const page = await serverRenderThenHydrate(ui);
    expect(selectedTab(page.container)).toBe('Overview');
    act(() => {
      window.location.hash = 'invoices';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(selectedTab(page.container)).toBe('Invoices');
    page.unmount();
  });

  it('writes the chosen tab to the hash', async () => {
    const page = await serverRenderThenHydrate(ui);
    const invoices = [...page.container.querySelectorAll<HTMLButtonElement>('[role="tab"]')][2];
    act(() => invoices?.click());
    expect(window.location.hash).toBe('#invoices');
    expect(visiblePanel(page.container)).toBe('invoices panel');
    page.unmount();
  });

  it('moves with the arrow keys in reading order in LTR', async () => {
    const page = await serverRenderThenHydrate(ui);
    press(page.container, 'ArrowRight');
    expect(selectedTab(page.container)).toBe('Containers');
    expect(document.activeElement?.textContent).toBe('Containers');
    press(page.container, 'ArrowLeft');
    press(page.container, 'ArrowLeft');
    expect(selectedTab(page.container)).toBe('Invoices'); // wraps around
    page.unmount();
  });

  it('moves with the arrow keys in reading order in RTL', async () => {
    document.documentElement.dir = 'rtl';
    const page = await serverRenderThenHydrate(ui);
    press(page.container, 'ArrowLeft');
    expect(selectedTab(page.container)).toBe('Containers');
    press(page.container, 'ArrowRight');
    expect(selectedTab(page.container)).toBe('Overview');
    press(page.container, 'ArrowRight');
    expect(selectedTab(page.container)).toBe('Invoices'); // wraps around
    page.unmount();
  });
});
