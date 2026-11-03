import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Integration test files run in parallel against one database. A test currency code is a primary
// key, so two files picking the same random code collide (CI failure on PR #173). Each file that
// creates test currencies owns one `Q<letter>` prefix and randomises only the third letter.
// (Two-letter `Q?` values elsewhere are country codes, not currencies.)
const testDir = join(__dirname, '..', 'test');
const files = readdirSync(testDir).filter((name) => name.endsWith('.int-spec.ts'));
const sources = files.map((name) => ({ name, text: readFileSync(join(testDir, name), 'utf8') }));

describe('integration test currency codes', () => {
  it('never randomise the second letter of a Q.. test currency', () => {
    const shared = sources
      .filter(({ text }) =>
        /`Q\$\{String\.fromCharCode\([^)]*\)\)\}\$\{String\.fromCharCode/.test(text),
      )
      .map(({ name }) => name);
    expect(shared).toEqual([]);
  });

  it('give each file its own Q<letter> prefix', () => {
    const owners = new Map<string, string[]>();
    for (const { name, text } of sources) {
      for (const [, prefix] of text.matchAll(/`(Q[A-Z])\$\{String\.fromCharCode/g)) {
        owners.set(prefix!, [...new Set([...(owners.get(prefix!) ?? []), name])]);
      }
    }
    expect(owners.size).toBeGreaterThan(0);
    const clashes = [...owners].filter(([, names]) => names.length > 1);
    expect(clashes).toEqual([]);
  });
});
