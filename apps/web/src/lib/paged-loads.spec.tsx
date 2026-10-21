// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { type PagedLoads, usePagedLoads } from './paged-loads';

function harness(): { get: () => { loads: PagedLoads; loading: boolean } } {
  let value: { loads: PagedLoads; loading: boolean } | null = null;
  function Probe() {
    value = usePagedLoads();
    return null;
  }
  const host = document.createElement('div');
  act(() => createRoot(host).render(<Probe />));
  return {
    get: () => {
      if (!value) throw new Error('not rendered');
      return value;
    },
  };
}

/** Runs a hook call and lets React apply the state it set. */
function call<T>(f: () => T): T {
  let result: T | undefined;
  act(() => {
    result = f();
  });
  return result as T;
}

describe('usePagedLoads', () => {
  it('sends one next page at a time, and none while a first page is loading', () => {
    const h = harness();
    const first = call(() => h.get().loads.first());
    expect(h.get().loading).toBe(true);
    expect(call(() => h.get().loads.next())).toBeNull();
    call(() => h.get().loads.done(first));
    expect(h.get().loading).toBe(false);
    const more = call(() => h.get().loads.next());
    expect(more).not.toBeNull();
    expect(call(() => h.get().loads.next())).toBeNull();
    call(() => h.get().loads.done(more ?? -1));
    expect(call(() => h.get().loads.next())).not.toBeNull();
  });

  it('drops a reply overtaken by a newer search or a cleared list', () => {
    const h = harness();
    const first = call(() => h.get().loads.first());
    call(() => h.get().loads.done(first));
    const more = call(() => h.get().loads.next()) ?? -1;
    const search = call(() => h.get().loads.first());
    expect(h.get().loads.current(more)).toBe(false);
    expect(h.get().loads.current(search)).toBe(true);
    // The overtaken reply ending does not end the newer load.
    call(() => h.get().loads.done(more));
    expect(h.get().loading).toBe(true);
    call(() => h.get().loads.reset());
    expect(h.get().loads.current(search)).toBe(false);
    expect(h.get().loading).toBe(false);
  });

  it('keeps the same loads object across renders', () => {
    const h = harness();
    const before = h.get().loads;
    call(() => h.get().loads.first());
    expect(h.get().loads).toBe(before);
  });
});
