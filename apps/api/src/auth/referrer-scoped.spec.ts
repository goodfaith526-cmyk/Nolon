import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Plan 18, 8: the routes open to Referrer Staff (@ReferrerScoped). The guard refuses them every
// other route, so this list is all a broker's own login can reach. A new route is opened here on
// purpose only.
const SRC = join(import.meta.dirname, '..');

const OPEN = [
  'auth/auth.controller.ts GET me',
  'auth/auth.controller.ts POST password',
  'referrer-portal/referrer-portal.controller.ts GET ',
  'referrer-portal/referrer-portal.controller.ts POST customers',
];

function openedRoutes(): string[] {
  const files = readdirSync(SRC, { recursive: true, encoding: 'utf8' }).filter((f) =>
    f.endsWith('.controller.ts'),
  );
  const found: string[] = [];
  for (const file of files) {
    const lines = readFileSync(join(SRC, file), 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (line.trim() !== '@ReferrerScoped()') return;
      const block = lines.slice(i + 1, i + 6).join('\n');
      const route = /@(Get|Post|Patch|Put|Delete)\((?:'([^']*)')?\)/.exec(block);
      found.push(`${file.replaceAll('\\', '/')} ${route?.[1]?.toUpperCase()} ${route?.[2] ?? ''}`);
    });
  }
  return found.sort();
}

describe('routes open to Referrer Staff', () => {
  it('are exactly the broker’s own screen and his account, nothing else', () => {
    expect(openedRoutes()).toEqual([...OPEN].sort());
  });
});
