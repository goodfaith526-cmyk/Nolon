-- CreateEnum
CREATE TYPE "renumbered_kind" AS ENUM ('BOOKING', 'SHIPMENT', 'CONSOLIDATION');

-- CreateEnum
CREATE TYPE "renumber_reason" AS ENUM ('MIGRATION', 'DRAFT_ROUTE_CHANGE');

-- AlterTable
ALTER TABLE "locations" ADD COLUMN     "short_code" VARCHAR(4);

-- CreateTable
CREATE TABLE "reference_renumberings" (
    "id" BIGSERIAL NOT NULL,
    "kind" "renumbered_kind" NOT NULL,
    "record_id" UUID NOT NULL,
    "old_number" VARCHAR(30) NOT NULL,
    "new_number" VARCHAR(30) NOT NULL,
    "reason" "renumber_reason" NOT NULL,
    "user_id" UUID,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reference_renumberings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "reference_renumberings_old_number_idx" ON "reference_renumberings"("old_number");

-- CreateIndex
CREATE INDEX "reference_renumberings_kind_record_id_idx" ON "reference_renumberings"("kind", "record_id");

-- ---------------------------------------------------------------------------------------------
-- Raw SQL, reviewed with the migration (plan docs/reviews/lcl-numbering-capacity-plan-2026-10-27.md,
-- sections 2, 4, 7 and 8). The owner asked for existing numbers to be renumbered (2026-10-27).
-- The whole file runs as one transaction: any check below that fails undoes all of it.
-- ---------------------------------------------------------------------------------------------

ALTER TABLE "locations" ADD CONSTRAINT "locations_short_code_check"
    CHECK ("short_code" IS NULL OR "short_code" ~ '^[A-Z]{2,4}$');

-- The renumbering log is insert-only, like the audit log.
CREATE FUNCTION "reference_renumberings_insert_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'Reference renumberings cannot be changed or deleted';
END;
$$;

CREATE TRIGGER "reference_renumberings_insert_only"
    BEFORE UPDATE OR DELETE ON "reference_renumberings"
    FOR EACH ROW EXECUTE FUNCTION "reference_renumberings_insert_only"();

CREATE TRIGGER "reference_renumberings_no_truncate"
    BEFORE TRUNCATE ON "reference_renumberings"
    FOR EACH STATEMENT EXECUTE FUNCTION "reference_renumberings_insert_only"();

-- The client's letters for the seeded places (owner, 2026-10-27): Jebel Ali and Dubai are DXB,
-- Port Sudan is PTS. A letter code an admin already set is kept.
UPDATE "locations" SET "short_code" = v."short_code"
FROM (VALUES ('AEJEA', 'DXB'), ('AEDXB', 'DXB'), ('SAJED', 'JED'), ('SDPZU', 'PTS'),
             ('SDATB', 'ATB'), ('SDKRT', 'KRT')) AS v("code", "short_code")
WHERE "locations"."code" = v."code" AND "locations"."short_code" IS NULL;

-- Each place's letters, as the API resolves them (MasterDataService.routeLetters): its own short
-- code, else its city's, else the last three characters of its code when they are three letters.
-- Null: the place has no letters, and records on its routes keep their numbers (listed below).
CREATE TEMPORARY TABLE "tmp_letters" ON COMMIT DROP AS
SELECT l."id",
       COALESCE(l."short_code", c."short_code",
                CASE WHEN right(l."code", 3) ~ '^[A-Z]{3}$' THEN right(l."code", 3) END) AS "letters"
FROM "locations" l
LEFT JOIN "locations" c ON c."id" = l."city_id";

-- New numbers, computed before anything changes. Only records still carrying an old-format
-- number are taken, so running this on renumbered data changes nothing.
CREATE TEMPORARY TABLE "tmp_renumber" (
    "kind"       "renumbered_kind" NOT NULL,
    "record_id"  UUID NOT NULL,
    "old_number" VARCHAR(30) NOT NULL,
    "new_number" VARCHAR(30) NOT NULL,
    "doc_type"   VARCHAR(30),
    "pair"       VARCHAR(10),
    "serial"     BIGINT
) ON COMMIT DROP;

-- LCL bookings: per rendered route pair, in creation order.
INSERT INTO "tmp_renumber" ("kind", "record_id", "old_number", "new_number", "doc_type", "pair", "serial")
SELECT 'BOOKING', b."id", b."number",
       r."pair" || '-' || lpad(r."serial"::text, 4, '0'), 'LCL_BOOKING', r."pair", r."serial"
FROM (
    SELECT b."id", o."letters" || '-' || d."letters" AS "pair",
           row_number() OVER (PARTITION BY o."letters", d."letters" ORDER BY b."created_at", b."id") AS "serial"
    FROM "bookings" b
    JOIN "tmp_letters" o ON o."id" = b."origin_location_id"
    JOIN "tmp_letters" d ON d."id" = b."destination_location_id"
    WHERE b."load_type" = 'LCL' AND b."number" ~ '^BK[0-9]+$'
      AND o."letters" IS NOT NULL AND d."letters" IS NOT NULL
) r
JOIN "bookings" b ON b."id" = r."id";

-- Shared containers: their own counter per rendered route pair, with C before the serial.
INSERT INTO "tmp_renumber" ("kind", "record_id", "old_number", "new_number", "doc_type", "pair", "serial")
SELECT 'CONSOLIDATION', c."id", c."number",
       r."pair" || '-C' || lpad(r."serial"::text, 4, '0'), 'LCL_CONTAINER', r."pair", r."serial"
FROM (
    SELECT c."id", o."letters" || '-' || d."letters" AS "pair",
           row_number() OVER (PARTITION BY o."letters", d."letters" ORDER BY c."created_at", c."id") AS "serial"
    FROM "consolidations" c
    JOIN "tmp_letters" o ON o."id" = c."origin_location_id"
    JOIN "tmp_letters" d ON d."id" = c."destination_location_id"
    WHERE c."number" ~ '^NOL-CON-'
      AND o."letters" IS NOT NULL AND d."letters" IS NOT NULL
) r
JOIN "consolidations" c ON c."id" = r."id";

-- Shipments: their booking's number, new or unchanged.
INSERT INTO "tmp_renumber" ("kind", "record_id", "old_number", "new_number")
SELECT 'SHIPMENT', s."id", s."number", COALESCE(t."new_number", b."number")
FROM "shipments" s
JOIN "bookings" b ON b."id" = s."booking_id"
LEFT JOIN "tmp_renumber" t ON t."kind" = 'BOOKING' AND t."record_id" = b."id"
WHERE s."number" ~ '^NOL-SHP-';

-- Checks before any write; one failure stops the whole migration.
DO $$
DECLARE
    bad TEXT;
BEGIN
    SELECT string_agg("kind" || ' ' || "new_number", ', ') INTO bad FROM (
        SELECT "kind", "new_number" FROM "tmp_renumber"
        WHERE length("new_number") > 30
           OR ("kind" = 'BOOKING' AND "new_number" !~ '^[A-Z]{2,4}-[A-Z]{2,4}-[0-9]{4,}$')
           OR ("kind" = 'CONSOLIDATION' AND "new_number" !~ '^[A-Z]{2,4}-[A-Z]{2,4}-C[0-9]{4,}$')
           OR ("kind" = 'SHIPMENT' AND "new_number" !~ '^(BK[0-9]{5,}|[A-Z]{2,4}-[A-Z]{2,4}-[0-9]{4,})$')
    ) x;
    IF bad IS NOT NULL THEN RAISE EXCEPTION 'Renumbering: bad new numbers: %', bad; END IF;

    SELECT string_agg("kind" || ' ' || "new_number", ', ') INTO bad FROM (
        SELECT "kind", "new_number" FROM "tmp_renumber" GROUP BY 1, 2 HAVING count(*) > 1
    ) x;
    IF bad IS NOT NULL THEN RAISE EXCEPTION 'Renumbering: duplicate new numbers: %', bad; END IF;

    -- A new number must not be another record's current number (one that keeps its number).
    SELECT string_agg(t."new_number", ', ') INTO bad FROM "tmp_renumber" t
    WHERE (t."kind" = 'BOOKING' AND EXISTS (SELECT 1 FROM "bookings" b
              WHERE b."number" = t."new_number" AND b."id" <> t."record_id"))
       OR (t."kind" = 'CONSOLIDATION' AND EXISTS (SELECT 1 FROM "consolidations" c
              WHERE c."number" = t."new_number" AND c."id" <> t."record_id"))
       OR (t."kind" = 'SHIPMENT' AND EXISTS (SELECT 1 FROM "shipments" s
              WHERE s."number" = t."new_number" AND s."id" <> t."record_id"
                AND NOT EXISTS (SELECT 1 FROM "tmp_renumber" u
                                WHERE u."kind" = 'SHIPMENT' AND u."record_id" = s."id")));
    IF bad IS NOT NULL THEN RAISE EXCEPTION 'Renumbering: numbers already taken: %', bad; END IF;

    -- Records whose route has no letters keep their numbers; the deploy log lists them.
    FOR bad IN
        SELECT 'booking ' || b."number" FROM "bookings" b
        JOIN "tmp_letters" o ON o."id" = b."origin_location_id"
        JOIN "tmp_letters" d ON d."id" = b."destination_location_id"
        WHERE b."load_type" = 'LCL' AND b."number" ~ '^BK[0-9]+$'
          AND (o."letters" IS NULL OR d."letters" IS NULL)
        UNION ALL
        SELECT 'container ' || c."number" FROM "consolidations" c
        JOIN "tmp_letters" o ON o."id" = c."origin_location_id"
        JOIN "tmp_letters" d ON d."id" = c."destination_location_id"
        WHERE c."number" ~ '^NOL-CON-' AND (o."letters" IS NULL OR d."letters" IS NULL)
    LOOP
        RAISE NOTICE 'Renumbering: % keeps its number (its route has no letters)', bad;
    END LOOP;
END;
$$;

UPDATE "bookings" b SET "number" = t."new_number"
FROM "tmp_renumber" t WHERE t."kind" = 'BOOKING' AND t."record_id" = b."id";

UPDATE "consolidations" c SET "number" = t."new_number"
FROM "tmp_renumber" t WHERE t."kind" = 'CONSOLIDATION' AND t."record_id" = c."id";

UPDATE "shipments" s SET "number" = t."new_number"
FROM "tmp_renumber" t WHERE t."kind" = 'SHIPMENT' AND t."record_id" = s."id";

INSERT INTO "reference_renumberings" ("kind", "record_id", "old_number", "new_number", "reason")
SELECT "kind", "record_id", "old_number", "new_number", 'MIGRATION'
FROM "tmp_renumber" WHERE "old_number" <> "new_number"
ORDER BY "kind", "record_id";

-- Each route counter continues after its highest number.
INSERT INTO "number_sequences" ("doc_type", "period_key", "next_value")
SELECT "doc_type", "pair", max("serial") + 1 FROM "tmp_renumber"
WHERE "doc_type" IS NOT NULL GROUP BY 1, 2
ON CONFLICT ("doc_type", "period_key")
DO UPDATE SET "next_value" = GREATEST("number_sequences"."next_value", EXCLUDED."next_value");
