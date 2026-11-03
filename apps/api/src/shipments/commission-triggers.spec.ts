import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CARGO_WRITES } from './commission-triggers.registry.js';

// Plan 07, 4.3 (F149-4): a fixed commission per unit follows the cargo lines, so every write of
// them is listed with the trigger that syncs the commission after it. A new one fails here until
// it is listed (and synced).

const SRC = join(import.meta.dirname, '..');
const WRITE =
  /\.(shipmentItem\.(?:create|createMany|createManyAndReturn|update|updateMany|upsert|delete|deleteMany)|shipment\.(?:create|createMany|upsert))\(/g;
const RAW = /(INSERT INTO|UPDATE|DELETE FROM)\s+"shipment_items"/g;

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'generated' ? [] : sources(path);
    return entry.name.endsWith('.ts') && !/\.(int-)?spec\.ts$/.test(entry.name) ? [path] : [];
  });
}

function found(): Record<string, Set<string>> {
  const result: Record<string, Set<string>> = {};
  for (const path of sources(SRC)) {
    const text = readFileSync(path, 'utf8');
    const file = relative(SRC, path).split(sep).join('/');
    // Seed data writes shipments outside any request; it is not a write path of the app.
    if (file.startsWith('seed/')) continue;
    const calls = [
      ...[...text.matchAll(WRITE)].map((m) => m[1] ?? ''),
      ...[...text.matchAll(RAW)].map((m) => `raw ${m[1] ?? ''}`),
    ];
    if (calls.length > 0) result[file] = new Set(calls);
  }
  return result;
}

describe('cargo line writes and the commission sync', () => {
  it('lists every write of a shipment’s cargo lines, and nothing that is gone', () => {
    const listed = Object.fromEntries(
      Object.entries(CARGO_WRITES).map(([file, calls]) => [file, new Set(Object.keys(calls))]),
    );
    expect(found()).toEqual(listed);
  });
});
