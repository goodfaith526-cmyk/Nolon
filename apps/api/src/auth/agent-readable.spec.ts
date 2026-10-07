import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Guards the list of routes opened to the staff AI assistant (@AgentReadable): JSON reads only.
// A new export, download, administration route or write must never be opened by accident.

const SRC = join(import.meta.dirname, '..');

/** Controllers that must open nothing to the assistant. */
const CLOSED_CONTROLLERS = [
  'agent-auth/agent-auth.controller.ts',
  'customer-service/customer-service.controller.ts',
  'users/users.controller.ts',
  'health/health.controller.ts',
  'shipments/public-tracking.controller.ts',
  'customers/customers-import.controller.ts',
  'rates/rates-import.controller.ts',
];

/** Opened routes: the decorator line and the next decorators and signature of the handler. */
function openedRoutes(): { file: string; handler: string }[] {
  const files = readdirSync(SRC, { recursive: true, encoding: 'utf8' }).filter((f) =>
    f.endsWith('.controller.ts'),
  );
  const found: { file: string; handler: string }[] = [];
  for (const file of files) {
    const lines = readFileSync(join(SRC, file), 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (line.trim() === '@AgentReadable()') {
        found.push({ file, handler: lines.slice(i + 1, i + 9).join('\n') });
      }
    });
  }
  return found;
}

describe('routes opened to the staff assistant', () => {
  const opened = openedRoutes();

  it('covers the ERP areas staff ask about', () => {
    expect(opened.length).toBeGreaterThanOrEqual(70);
  });

  it('are GET routes only', () => {
    for (const { file, handler } of opened) {
      expect(handler, file).toMatch(/^\s*@Get\(/);
    }
  });

  it('never export, download, stream or administer', () => {
    for (const { file, handler } of opened) {
      const route = /@Get\(([^)]*)\)/.exec(handler)?.[1] ?? '';
      expect(route, file).not.toMatch(
        /export|\/file|qr|by-token|template|settings|audit-log|users/,
      );
      expect(handler, `${file} ${route}`).not.toMatch(/@Res\(|@Header\(|StreamableFile/);
    }
  });

  it('are absent from controllers that must stay closed', () => {
    for (const file of CLOSED_CONTROLLERS) {
      expect(
        opened.filter((o) => o.file === file),
        file,
      ).toEqual([]);
    }
  });
});
