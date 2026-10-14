import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PURGED_DRAFT_MODELS } from './draft-retention.service.js';
import { DRAFT_TABLES } from './drafts.service.js';

// The key ledger (assistant_draft_keys) keeps a created draft's outcome after the draft row is
// gone only because the retention purge writes it, in its transaction, before it deletes drafts.
// That holds only while nothing else deletes a draft row: no other code, and no cascade.

const SRC = join(import.meta.dirname, '..');
const SCHEMA = readFileSync(join(SRC, '..', 'prisma', 'schema.prisma'), 'utf8');

/** Prisma delegates of the draft models (grnDraft, quotationDraft, ...). */
const delegates = Object.keys(PURGED_DRAFT_MODELS).map((m) => m[0]!.toLowerCase() + m.slice(1));

function sources(): { file: string; text: string }[] {
  return readdirSync(SRC, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts') && !f.startsWith('generated'))
    .map((file) => ({ file, text: readFileSync(join(SRC, file), 'utf8') }));
}

describe('draft rows', () => {
  it('are deleted only by the retention purge', () => {
    const deleting = sources()
      .filter(
        ({ text }) =>
          delegates.some((d) => new RegExp(`\\.${d}\\.delete(Many)?\\(`).test(text)) ||
          DRAFT_TABLES.some((table) =>
            new RegExp(`DELETE\\s+FROM\\s+"?${table}"?`, 'i').test(text),
          ),
      )
      .map(({ file }) => file);
    expect(deleting).toEqual([join('drafts', 'draft-retention.service.ts')]);
  });

  it('are never deleted by a cascade: every relation a draft model holds restricts', () => {
    for (const model of Object.keys(PURGED_DRAFT_MODELS)) {
      const body = new RegExp(`^model ${model} \\{([\\s\\S]*?)^\\}`, 'm').exec(SCHEMA)?.[1];
      expect(body, model).toBeDefined();
      const relations = (body ?? '').split('\n').filter((l) => /@relation\(.*fields:/.test(l));
      for (const line of relations) expect(line, model).toMatch(/onDelete: Restrict/);
    }
  });

  it('are covered by the ledger step, table for model', () => {
    const tables = Object.keys(PURGED_DRAFT_MODELS).map(
      (model) =>
        new RegExp(`^model ${model} \\{[\\s\\S]*?@@map\\("(\\w+)"\\)`, 'm').exec(SCHEMA)?.[1],
    );
    expect([...tables].sort()).toEqual([...DRAFT_TABLES].sort());
  });
});
