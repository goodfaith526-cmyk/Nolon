import { describe, expect, it } from 'vitest';
import { reviewMigrations, statements } from './additive-migrations.js';

const review = (...sql: string[]) =>
  reviewMigrations(sql.map((s, i) => ({ file: `m${i}`, sql: s }))).map((f) => f.reason);

describe('statements', () => {
  it('splits on semicolons outside comments, strings, identifiers and $$ bodies', () => {
    const sql = `-- a; comment
CREATE TABLE "a;b" ("x" TEXT DEFAULT 'y;z''q;');
/* block; */ CREATE FUNCTION f() RETURNS trigger AS $$ BEGIN RAISE 'no;'; END; $$ LANGUAGE plpgsql;
CREATE TYPE "t" AS ENUM ('a')`;
    expect(statements(sql)).toEqual([
      `CREATE TABLE "a;b" ("x" TEXT DEFAULT 'y;z''q;')`,
      `CREATE FUNCTION f() RETURNS trigger AS $$ BEGIN RAISE 'no;'; END; $$ LANGUAGE plpgsql`,
      `CREATE TYPE "t" AS ENUM ('a')`,
    ]);
  });
});

describe('reviewMigrations', () => {
  it('passes a migration that only adds objects (as Prisma writes them)', () => {
    expect(
      review(`
CREATE TYPE "grn_draft_state" AS ENUM ('DRAFT', 'APPROVED');
CREATE TABLE "grn_drafts" ("id" UUID NOT NULL, "shipment_id" UUID NOT NULL, CONSTRAINT "grn_drafts_pkey" PRIMARY KEY ("id"));
CREATE UNIQUE INDEX "grn_drafts_key" ON "grn_drafts"("shipment_id");
CREATE INDEX "shipments_note_idx" ON "shipments"("note");
ALTER TABLE "grn_drafts" ADD CONSTRAINT "grn_drafts_shipment_id_fkey" FOREIGN KEY ("shipment_id") REFERENCES "shipments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "grn_drafts" ADD CONSTRAINT "grn_drafts_check" CHECK ("id" IS NOT NULL);
ALTER TABLE "shipments" ADD COLUMN "draft_note" TEXT, ADD COLUMN "draft_count" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "shipments" ADD COLUMN "draft_id" UUID;
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_draft_id_fkey" FOREIGN KEY ("draft_id") REFERENCES "grn_drafts"("id");
ALTER TYPE "shipment_status" ADD VALUE 'ON_HOLD';
CREATE FUNCTION "grn_drafts_guard"() RETURNS trigger AS $$ BEGIN IF OLD."id" IS NOT NULL THEN RAISE EXCEPTION 'decided'; END IF; UPDATE "grn_drafts" SET "id" = NEW."id"; RETURN NEW; END; $$ LANGUAGE plpgsql;
CREATE TRIGGER "grn_drafts_guard" BEFORE UPDATE ON "grn_drafts" FOR EACH ROW EXECUTE FUNCTION "grn_drafts_guard"();
INSERT INTO "grn_drafts" ("id", "shipment_id") VALUES (gen_random_uuid(), gen_random_uuid());`),
    ).toEqual([]);
  });

  it('counts tables created by an earlier migration of the same pull request as new', () => {
    expect(
      review(
        'CREATE TABLE "a" ("id" UUID)',
        'CREATE TRIGGER "t" AFTER INSERT ON "a" FOR EACH ROW EXECUTE FUNCTION f()',
      ),
    ).toEqual([]);
  });

  it.each([
    ['DROP TABLE "shipments"', 'not an additive statement'],
    ['DROP INDEX "shipments_note_idx"', 'not an additive statement'],
    [
      'ALTER TABLE "shipments" DROP COLUMN "note"',
      'changes existing table shipments: DROP COLUMN "note"',
    ],
    [
      'ALTER TABLE "shipments" RENAME COLUMN "note" TO "notes"',
      'changes existing table shipments: RENAME COLUMN "note"',
    ],
    [
      'ALTER TABLE "shipments" ALTER COLUMN "note" SET NOT NULL',
      'changes existing table shipments: ALTER COLUMN "note"',
    ],
    [
      'ALTER TABLE "shipments" ALTER COLUMN "weight" TYPE DECIMAL(18,2)',
      'changes existing table shipments: ALTER COLUMN "weight"',
    ],
    [
      'ALTER TABLE "shipments" DISABLE TRIGGER ALL',
      'changes existing table shipments: DISABLE TRIGGER ALL',
    ],
    [
      'ALTER TABLE "shipments" ADD COLUMN "code" TEXT NOT NULL',
      'new NOT NULL column without a default on existing table shipments',
    ],
    [
      'ALTER TABLE "shipments" ADD CONSTRAINT "c" CHECK ("weight" > 0)',
      'constraint on existing table shipments',
    ],
    [
      'ALTER TABLE "shipments" ADD CONSTRAINT "f" FOREIGN KEY ("customer_id") REFERENCES "customers"("id")',
      'constraint on existing table shipments',
    ],
    [
      'CREATE UNIQUE INDEX "u" ON "shipments"("number")',
      'unique index on existing table shipments',
    ],
    [
      'CREATE TRIGGER "t" BEFORE DELETE ON "shipments" FOR EACH ROW EXECUTE FUNCTION f()',
      'trigger on existing table shipments',
    ],
    [
      'CREATE OR REPLACE FUNCTION f() RETURNS trigger AS $$ BEGIN RETURN NEW; END; $$ LANGUAGE plpgsql',
      'not an additive statement',
    ],
    ['UPDATE "shipments" SET "note" = NULL', 'not an additive statement'],
    ['DELETE FROM "documents"', 'not an additive statement'],
    [
      'INSERT INTO "charge_types" ("code") VALUES (\'X\')',
      'inserts rows into existing table charge_types',
    ],
    ['CREATE VIEW "v" AS SELECT 1', 'not an additive statement'],
    ['GRANT ALL ON "shipments" TO public', 'not an additive statement'],
    ['DO $$ BEGIN PERFORM 1; END $$', 'not an additive statement'],
    [
      'CREATE FUNCTION f() RETURNS trigger AS $$ BEGIN DELETE FROM shipments; RETURN NEW; END; $$ LANGUAGE plpgsql',
      'function changes existing object shipments',
    ],
    [
      'CREATE FUNCTION f() RETURNS trigger AS $$ BEGIN UPDATE "public"."documents" SET x = 1; RETURN NEW; END; $$ LANGUAGE plpgsql',
      'function changes existing object documents',
    ],
    [
      "CREATE FUNCTION f() RETURNS void AS $$ BEGIN EXECUTE current_setting('app.sql'); END; $$ LANGUAGE plpgsql",
      'function runs dynamic SQL',
    ],
  ])('flags %s', (sql, reason) => {
    expect(review(sql)).toEqual([reason]);
  });

  it('flags anything that names an accounting table or type, even when it only adds', () => {
    expect(review('CREATE INDEX "j" ON "journal_entries"("posted_at")')).toEqual([
      'touches accounting: journal_entries',
    ]);
    expect(review('ALTER TABLE journal_lines ADD COLUMN memo TEXT')).toEqual([
      'touches accounting: journal_lines',
    ]);
    expect(review('ALTER TYPE "journal_source" ADD VALUE \'GRN\'')).toEqual([
      'touches accounting: journal_source',
    ]);
    expect(
      review(
        'CREATE TABLE "x" ("id" UUID, "entry_id" UUID REFERENCES "public"."journal_entries"("id"))',
      ),
    ).toEqual(['touches accounting: journal_entries']);
  });

  it('is not fooled by comments or by a semicolon inside a string', () => {
    expect(
      review(
        `CREATE TABLE "a" ("x" TEXT DEFAULT ';DROP TABLE shipments') -- ; DROP TABLE shipments`,
      ),
    ).toEqual([]);
    expect(review('/* harmless */ DROP TABLE "shipments"')).toEqual(['not an additive statement']);
  });
});
