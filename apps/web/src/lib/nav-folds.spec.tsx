// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { serverRenderThenHydrate } from '@/test/hydrate';
import { useFoldedSections } from './nav-folds';

type Title = 'commercial' | 'fleet' | 'settings';
const ALL: readonly Title[] = ['commercial', 'fleet', 'settings'];
const DEFAULTS: readonly Title[] = ['fleet', 'settings'];

function Nav() {
  const [folded, toggle] = useFoldedSections(ALL, DEFAULTS);
  return (
    <ul>
      {ALL.map((title) => (
        <li key={title}>
          <button type="button" data-title={title} onClick={() => toggle(title)}>
            {folded.has(title) ? 'folded' : 'open'}
          </button>
        </li>
      ))}
    </ul>
  );
}

function states(container: HTMLElement): Record<string, string | null> {
  const result: Record<string, string | null> = {};
  for (const b of container.querySelectorAll('button'))
    result[b.dataset.title ?? ''] = b.textContent;
  return result;
}

describe('useFoldedSections', () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => document.body.replaceChildren());

  it('uses the defaults when nothing is saved', async () => {
    const page = await serverRenderThenHydrate(() => <Nav />);
    expect(page.problems).toEqual([]);
    expect(states(page.container)).toEqual({
      commercial: 'open',
      fleet: 'folded',
      settings: 'folded',
    });
    page.unmount();
  });

  it('restores the saved folds after a reload, without hydration warnings', async () => {
    const page = await serverRenderThenHydrate(
      () => <Nav />,
      () => window.localStorage.setItem('nolon.nav.folded', JSON.stringify(['commercial'])),
    );
    expect(page.problems).toEqual([]);
    expect(states(page.container)).toEqual({
      commercial: 'folded',
      fleet: 'open',
      settings: 'open',
    });
    page.unmount();
  });

  it('saves a toggle and keeps it across a reload', async () => {
    const first = await serverRenderThenHydrate(() => <Nav />);
    act(() => first.container.querySelector<HTMLButtonElement>('[data-title="fleet"]')?.click());
    expect(states(first.container).fleet).toBe('open');
    first.unmount();

    const reloaded = await serverRenderThenHydrate(() => <Nav />);
    expect(reloaded.problems).toEqual([]);
    expect(states(reloaded.container)).toEqual({
      commercial: 'open',
      fleet: 'open',
      settings: 'folded',
    });
    reloaded.unmount();
  });

  it('ignores a corrupt or unknown saved value', async () => {
    window.localStorage.setItem('nolon.nav.folded', '{not json');
    const corrupt = await serverRenderThenHydrate(() => <Nav />);
    expect(states(corrupt.container).fleet).toBe('folded');
    corrupt.unmount();

    window.localStorage.setItem('nolon.nav.folded', JSON.stringify(['ghost', 'settings']));
    const unknown = await serverRenderThenHydrate(() => <Nav />);
    expect(states(unknown.container)).toEqual({
      commercial: 'open',
      fleet: 'open',
      settings: 'folded',
    });
    unknown.unmount();
  });
});
