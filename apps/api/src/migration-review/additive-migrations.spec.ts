import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  createdTables,
  migrationsDigest,
  reviewMigrations,
  signOffLabel,
} from './additive-migrations.js';

// Tables that exist before the pull request, as the base branch's migrations created them.
const EXISTING = new Set(['shipments', 'customers', 'documents', 'charge_types', 'users']);
const review = (...sql: string[]) =>
  reviewMigrations(
    sql.map((s, i) => ({ file: `m${i}`, sql: s })),
    EXISTING,
  ).map((f) => f.reason);
const NOT_ALLOWED = 'not in the allowed additive subset';

describe('reviewMigrations: what passes', () => {
  it('passes a migration that only adds objects, as Prisma and the GRN drafts migration write them', () => {
    expect(
      review(`
-- A comment; with a semicolon.
CREATE TYPE "grn_draft_state" AS ENUM ('DRAFT', 'APPROVED');
CREATE TABLE "grn_drafts" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "shipment_id" UUID NOT NULL,
  "state" "grn_draft_state" NOT NULL DEFAULT 'DRAFT',
  "note" TEXT DEFAULT ';DROP TABLE shipments',
  CONSTRAINT "grn_drafts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "grn_drafts_key" ON "grn_drafts"("shipment_id");
CREATE INDEX "shipments_note_idx" ON "shipments"("note", "status");
CREATE INDEX "shipments_trgm_idx" ON "shipments" USING gin ("note");
ALTER TABLE "grn_drafts" ADD CONSTRAINT "grn_drafts_shipment_id_fkey" FOREIGN KEY ("shipment_id") REFERENCES "shipments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "grn_drafts" ADD CONSTRAINT "grn_drafts_check" CHECK ("id" IS NOT NULL);
ALTER TABLE "shipments" ADD COLUMN     "draft_note" VARCHAR(50),
ADD COLUMN     "draft_total" DECIMAL(18,4) NOT NULL DEFAULT 0,
ADD COLUMN     "draft_open" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "draft_at" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "shipments" ADD COLUMN "draft_id" UUID;
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_draft_id_fkey" FOREIGN KEY ("draft_id") REFERENCES "grn_drafts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TYPE "shipment_status" ADD VALUE 'ON_HOLD';
INSERT INTO "grn_drafts" ("id", "shipment_id") VALUES (gen_random_uuid(), '00000000-0000-0000-0000-000000000000') ON CONFLICT ("id") DO NOTHING;`),
    ).toEqual([]);
  });

  it('passes the trigger functions of #38: they read new tables and raise', () => {
    const sql = readFileSync(
      new URL('../../prisma/migrations/20261010033736_grn_drafts/migration.sql', import.meta.url),
      'utf8',
    );
    expect(review(sql)).toEqual([]);
  });

  it('counts tables created by an earlier migration of the same pull request as new', () => {
    expect(
      review(
        'CREATE TABLE "a" ("id" UUID)',
        `CREATE FUNCTION "f"() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'no'; END; $$ LANGUAGE plpgsql;
         CREATE TRIGGER "t" AFTER INSERT ON "a" FOR EACH ROW EXECUTE FUNCTION "f"();
         CREATE UNIQUE INDEX "u" ON "a"("id")`,
      ),
    ).toEqual([]);
  });
});

describe('reviewMigrations: what needs the owner', () => {
  it.each([
    // Codex review of #39, case by case.
    [
      'a unique column added to an existing table',
      'ALTER TABLE "shipments" ADD COLUMN "review_gate_unique" INTEGER NOT NULL DEFAULT 0 UNIQUE',
    ],
    [
      'a foreign key on a defaulted NOT NULL column (old rows hold the default)',
      `ALTER TABLE "shipments" ADD COLUMN "owner_id" UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000';
       ALTER TABLE "shipments" ADD CONSTRAINT "f" FOREIGN KEY ("owner_id") REFERENCES "customers"("id")`,
    ],
    [
      'CREATE TABLE IF NOT EXISTS over an existing table, then a unique index on it',
      `CREATE TABLE IF NOT EXISTS "shipments" ("id" UUID);
       CREATE UNIQUE INDEX "u" ON "shipments"("customer_id")`,
    ],
    ['a unique index on an existing table', 'CREATE UNIQUE INDEX "u" ON "shipments"("number")'],
    [
      'a partial or expression index on an existing table',
      'CREATE INDEX "i" ON "shipments"(lower("note"))',
    ],
    [
      'an index WHERE clause on an existing table',
      'CREATE INDEX "i" ON "shipments"("note") WHERE "note" IS NOT NULL',
    ],
    [
      'a CHECK on an existing table',
      'ALTER TABLE "shipments" ADD CONSTRAINT "c" CHECK ("weight" > 0)',
    ],
    [
      'a column with a computed default',
      'ALTER TABLE "shipments" ADD COLUMN "n" INTEGER DEFAULT nextval(\'s\')',
    ],
    [
      'a generated column',
      'ALTER TABLE "shipments" ADD COLUMN "n" INTEGER GENERATED ALWAYS AS (1) STORED',
    ],
    [
      'a column with REFERENCES inline',
      'ALTER TABLE "shipments" ADD COLUMN "c" UUID REFERENCES "customers"("id")',
    ],
    [
      'a NOT NULL column without a default',
      'ALTER TABLE "shipments" ADD COLUMN "code" TEXT NOT NULL',
    ],
    ['a dropped column', 'ALTER TABLE "shipments" DROP COLUMN "note"'],
    ['a renamed column', 'ALTER TABLE "shipments" RENAME COLUMN "note" TO "notes"'],
    ['a type change', 'ALTER TABLE "shipments" ALTER COLUMN "weight" TYPE DECIMAL(18,2)'],
    ['a disabled trigger', 'ALTER TABLE "shipments" DISABLE TRIGGER ALL'],
    [
      'a second action that is not additive',
      'ALTER TABLE "shipments" ADD COLUMN "a" TEXT, DROP COLUMN "note"',
    ],
    ['a table that already exists', 'CREATE TABLE "shipments" ("id" UUID)'],
    ['a table in another schema', 'CREATE TABLE other."shipments" ("id" UUID)'],
    ['a dropped table', 'DROP TABLE "shipments"'],
    ['a dropped index', 'DROP INDEX "shipments_note_idx"'],
    [
      'a trigger on an existing table',
      'CREATE TRIGGER "t" BEFORE DELETE ON "shipments" FOR EACH ROW EXECUTE FUNCTION "f"()',
    ],
    [
      'a trigger that runs a function this change does not create',
      'CREATE TABLE "a" ("id" UUID); CREATE TRIGGER "t" AFTER INSERT ON "a" FOR EACH ROW EXECUTE FUNCTION "old_fn"()',
    ],
    [
      'a replaced function',
      'CREATE OR REPLACE FUNCTION "f"() RETURNS trigger AS $$ BEGIN RETURN NEW; END; $$ LANGUAGE plpgsql',
    ],
    [
      'a function that writes',
      'CREATE FUNCTION "f"() RETURNS trigger AS $$ BEGIN DELETE FROM "shipments"; RETURN NEW; END; $$ LANGUAGE plpgsql',
    ],
    [
      'a function that writes, in capitals',
      'CREATE FUNCTION f() RETURNS TRIGGER AS $$ BEGIN UPDATE SHIPMENTS SET NOTE = 1; RETURN NEW; END; $$ LANGUAGE PLPGSQL',
    ],
    [
      'a function with dynamic SQL',
      "CREATE FUNCTION f() RETURNS trigger AS $$ BEGIN EXECUTE current_setting('x'); RETURN NEW; END; $$ LANGUAGE plpgsql",
    ],
    [
      'a function that calls another function',
      'CREATE FUNCTION f() RETURNS trigger AS $$ BEGIN IF pg_terminate_backend(1) THEN RETURN NEW; END IF; END; $$ LANGUAGE plpgsql',
    ],
    [
      'a function that reads an existing table',
      'CREATE FUNCTION f() RETURNS trigger AS $$ DECLARE n int; BEGIN SELECT 1 INTO n FROM "users"; RETURN NEW; END; $$ LANGUAGE plpgsql',
    ],
    [
      'a SECURITY DEFINER function',
      'CREATE FUNCTION f() RETURNS trigger SECURITY DEFINER AS $$ BEGIN RETURN NEW; END; $$ LANGUAGE plpgsql',
    ],
    ['rows inserted into an existing table', 'INSERT INTO "charge_types" ("code") VALUES (\'X\')'],
    [
      'rows copied by a query',
      'CREATE TABLE "a" ("id" UUID); INSERT INTO "a" ("id") SELECT "id" FROM "users"',
    ],
    ['an update', 'UPDATE "shipments" SET "note" = NULL'],
    ['a delete', 'DELETE FROM "documents"'],
    ['a view', 'CREATE VIEW "v" AS SELECT 1'],
    ['a grant', 'GRANT ALL ON "shipments" TO public'],
    ['a DO block', 'DO $$ BEGIN PERFORM 1; END $$'],
    [
      'an escape string that would hide a statement',
      `CREATE TABLE "a" ("x" TEXT DEFAULT E'\\''); DROP TABLE "shipments"; --')`,
    ],
    ['an unterminated string', 'CREATE TABLE "a" ("x" TEXT DEFAULT \'oops)'],
  ])('flags %s', (_, sql) => {
    expect(review(sql)).not.toEqual([]);
  });

  it('flags only the statements outside the subset, with a reason', () => {
    expect(
      review('CREATE TABLE "a" ("id" UUID); DROP TABLE "shipments"; CREATE INDEX "i" ON "a"("id")'),
    ).toEqual([NOT_ALLOWED]);
    expect(review('CREATE UNIQUE INDEX "u" ON "shipments"("number")')).toEqual([
      'unique index on existing table shipments',
    ]);
    expect(review('CREATE TABLE "shipments" ("id" UUID)')).toEqual([
      'table shipments already exists',
    ]);
  });

  it.each([
    'CREATE INDEX "j" ON "journal_entries"("posted_at")',
    'ALTER TABLE journal_lines ADD COLUMN memo TEXT',
    // PostgreSQL folds unquoted names: these are the same tables.
    'ALTER TABLE JOURNAL_ENTRIES ADD COLUMN gate_note TEXT',
    'alter table Journal_Entries add column gate_note text',
    'ALTER TABLE public.JOURNAL_LINES ADD COLUMN memo TEXT',
    'ALTER TABLE "public"."receipts" ADD COLUMN memo TEXT',
    "ALTER TYPE JOURNAL_SOURCE ADD VALUE 'GRN'",
    'CREATE TABLE "x" ("id" UUID, "entry_id" UUID REFERENCES "journal_entries"("id"))',
    'CREATE TABLE "x" ("id" UUID, "kind" "Journal_Status")',
    'CREATE TABLE "a" ("id" UUID); CREATE FUNCTION f() RETURNS trigger AS $$ DECLARE n int; BEGIN SELECT 1 INTO n FROM Accounts; RETURN NEW; END; $$ LANGUAGE plpgsql',
  ])('flags anything naming an accounting object, in any case or quoting: %s', (sql) => {
    expect(review(sql).some((r) => r.startsWith('touches accounting'))).toBe(true);
  });
});

describe('sign-off', () => {
  const a = [{ file: 'm/1/migration.sql', sql: 'ALTER TABLE "shipments" DROP COLUMN "note";' }];
  const b = [{ file: 'm/1/migration.sql', sql: 'ALTER TABLE "shipments" DROP COLUMN "status";' }];

  it('names the exact migrations: any change to them, or another file, needs a new sign-off', () => {
    expect(signOffLabel(a)).toMatch(/^migration-ok-[0-9a-f]{16}$/);
    expect(signOffLabel(a)).toBe(signOffLabel([...a]));
    expect(signOffLabel(b)).not.toBe(signOffLabel(a));
    expect(
      signOffLabel([...a, { file: 'm/2/migration.sql', sql: 'DROP TABLE "users";' }]),
    ).not.toBe(signOffLabel(a));
    expect(migrationsDigest([{ file: 'm/1/migration.sql', sql: a[0]?.sql + ' ' }])).not.toBe(
      migrationsDigest(a),
    );
  });

  it('cannot be carried over by later pushes: the label is checked against the content of every run', () => {
    // Codex's A/B/C case: the owner signs off A; B changes the migration and its run is cancelled;
    // C changes only code. The label on the PR still names A, and C's migrations are B's.
    const labelOnPr = signOffLabel(a);
    const migrationsAtC = b;
    expect(signOffLabel(migrationsAtC)).not.toBe(labelOnPr);
  });
});

describe('createdTables', () => {
  it('reads the tables the base branch has, from the real migrations', () => {
    const dir = new URL('../../prisma/migrations/', import.meta.url);
    const sqls = readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => readFileSync(new URL(`${d.name}/migration.sql`, dir), 'utf8'));
    const tables = createdTables(sqls);
    for (const table of ['shipments', 'documents', 'journal_entries', 'grn_drafts', 'users']) {
      expect(tables.has(table)).toBe(true);
    }
  });
});
