import { type ReactNode, act } from 'react';
import { type Root, hydrateRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { vi } from 'vitest';

// Tells React this environment supports act(), so it flushes effects and store updates inside it.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Renders `ui` on the "server" (server snapshots only), then hydrates that HTML in the DOM the way
 * a reload does, and collects every hydration error and console warning React raised.
 */
export async function serverRenderThenHydrate(ui: () => ReactNode, beforeHydrate?: () => void) {
  const html = renderToString(<>{ui()}</>);
  // The browser's own state (URL hash, storage), which the server never sees.
  beforeHydrate?.();
  const container = document.createElement('div');
  container.innerHTML = html;
  document.body.replaceChildren(container);

  const problems: string[] = [];
  const consoleError = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    problems.push(args.map(String).join(' '));
  });
  let root: Root | undefined;
  await act(async () => {
    root = hydrateRoot(container, <>{ui()}</>, {
      onRecoverableError: (error) => problems.push(String(error)),
    });
    await Promise.resolve();
  });
  consoleError.mockRestore();
  return {
    container,
    problems,
    unmount: () => act(() => root?.unmount()),
  };
}
