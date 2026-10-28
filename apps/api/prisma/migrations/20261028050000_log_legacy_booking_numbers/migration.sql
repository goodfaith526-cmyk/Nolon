-- ---------------------------------------------------------------------------------------------
-- Raw SQL, reviewed with the migration. The whole file runs as one transaction.
--
-- 1. The bookings 20261027235015_legacy_booking_numbers took off their first numbers
--    (NOL-BK-2026-000001) go into the renumbering log with the number they carry now, so staff
--    search finds them by their first number. Then its working table goes.
-- 2. Bookings still numbered NOL-BK-… are on a database where 20261027235016_route_numbers_renumbering
--    succeeded before 235015 existed (their bookings had no shipments yet), so 235015 left them.
--    They are numbered here as that renumbering numbers bookings: an LCL booking whose route has
--    letters takes the next number of its route counter (DXB-PTS-0004), any other the next BK
--    number; their shipments take the booking's number; everything is logged and the counters
--    continue after. On any other database no booking is still numbered NOL-BK-… and this changes
--    no row.
-- ---------------------------------------------------------------------------------------------

INSERT INTO "reference_renumberings" ("kind", "record_id", "old_number", "new_number", "reason")
SELECT 'BOOKING', b."id", l."old_number", b."number", 'MIGRATION'
FROM "legacy_booking_numbers" l
JOIN "bookings" b ON b."id" = l."id"
ORDER BY b."id";

DROP TABLE "legacy_booking_numbers";

-- Each place's letters, exactly as in 20261027235016_route_numbers_renumbering.
CREATE TEMPORARY TABLE "tmp_letters" AS
SELECT l."id",
       COALESCE(l."short_code", c."short_code",
                CASE WHEN right(l."code", 3) ~ '^[A-Z]{3}$' THEN right(l."code", 3) END) AS "letters"
FROM "locations" l
LEFT JOIN "locations" c ON c."id" = l."city_id";

-- The remaining old bookings and their counter: the route pair for LCL with letters, else BK.
CREATE TEMPORARY TABLE "tmp_old_bookings" AS
SELECT b."id", b."number" AS "old_number", b."created_at",
       CASE WHEN b."load_type" = 'LCL' AND o."letters" IS NOT NULL AND d."letters" IS NOT NULL
            THEN o."letters" || '-' || d."letters" END AS "pair"
FROM "bookings" b
LEFT JOIN "tmp_letters" o ON o."id" = b."origin_location_id"
LEFT JOIN "tmp_letters" d ON d."id" = b."destination_location_id"
WHERE b."number" ~ '^NOL-BK-';

-- Each counter starts after its stored value and after every number of its series in use.
CREATE TEMPORARY TABLE "tmp_starts" AS
SELECT p."pair",
       CASE WHEN p."pair" IS NULL THEN GREATEST(
                COALESCE((SELECT "next_value" FROM "number_sequences"
                          WHERE "doc_type" = 'BOOKING' AND "period_key" = ''), 1),
                COALESCE((SELECT max(substring("number" FROM 3)::bigint) + 1 FROM "bookings"
                          WHERE "number" ~ '^BK[0-9]+$'), 1))
            ELSE GREATEST(
                COALESCE((SELECT "next_value" FROM "number_sequences"
                          WHERE "doc_type" = 'LCL_BOOKING' AND "period_key" = p."pair"), 1),
                COALESCE((SELECT max(substring("number" FROM length(p."pair") + 2)::bigint) + 1
                          FROM "bookings" WHERE "number" ~ ('^' || p."pair" || '-[0-9]{4,}$')), 1))
       END AS "start"
FROM (SELECT DISTINCT "pair" FROM "tmp_old_bookings") p;

CREATE TEMPORARY TABLE "tmp_renumber" AS
SELECT 'BOOKING'::"renumbered_kind" AS "kind", n."id" AS "record_id", n."old_number",
       CASE WHEN n."pair" IS NULL
            THEN 'BK' || lpad(n."serial"::text, greatest(5, length(n."serial"::text)), '0')
            ELSE n."pair" || '-' || lpad(n."serial"::text, greatest(4, length(n."serial"::text)), '0')
       END::varchar(30) AS "new_number",
       CASE WHEN n."pair" IS NULL THEN 'BOOKING' ELSE 'LCL_BOOKING' END::varchar(30) AS "doc_type",
       COALESCE(n."pair", '')::varchar(10) AS "period_key", n."serial"
FROM (
    SELECT o."id", o."old_number", o."pair",
           s."start" + row_number() OVER (PARTITION BY o."pair" ORDER BY o."created_at", o."id") - 1 AS "serial"
    FROM "tmp_old_bookings" o
    JOIN "tmp_starts" s ON s."pair" IS NOT DISTINCT FROM o."pair"
) n;

-- Their shipments: the booking's new number, as the renumbering does.
INSERT INTO "tmp_renumber" ("kind", "record_id", "old_number", "new_number")
SELECT 'SHIPMENT', s."id", s."number", t."new_number"
FROM "shipments" s
JOIN "tmp_renumber" t ON t."kind" = 'BOOKING' AND t."record_id" = s."booking_id"
WHERE s."number" ~ '^NOL-SHP-' OR s."number" = t."old_number";

-- Checks before any write; one failure stops the whole migration.
DO $$
DECLARE
    bad TEXT;
BEGIN
    SELECT string_agg(t."kind" || ' ' || t."new_number", ', ') INTO bad FROM "tmp_renumber" t
    WHERE (t."kind" = 'BOOKING' AND EXISTS (SELECT 1 FROM "bookings" b
              WHERE b."number" = t."new_number" AND b."id" <> t."record_id"))
       OR (t."kind" = 'SHIPMENT' AND EXISTS (SELECT 1 FROM "shipments" s
              WHERE s."number" = t."new_number" AND s."id" <> t."record_id"));
    IF bad IS NOT NULL THEN RAISE EXCEPTION 'Legacy renumbering: numbers already taken: %', bad; END IF;
END;
$$;

UPDATE "bookings" b SET "number" = t."new_number"
FROM "tmp_renumber" t WHERE t."kind" = 'BOOKING' AND t."record_id" = b."id";

UPDATE "shipments" s SET "number" = t."new_number"
FROM "tmp_renumber" t WHERE t."kind" = 'SHIPMENT' AND t."record_id" = s."id";

INSERT INTO "reference_renumberings" ("kind", "record_id", "old_number", "new_number", "reason")
SELECT "kind", "record_id", "old_number", "new_number", 'MIGRATION'
FROM "tmp_renumber" WHERE "old_number" <> "new_number"
ORDER BY "kind", "record_id";

INSERT INTO "number_sequences" ("doc_type", "period_key", "next_value")
SELECT "doc_type", "period_key", max("serial") + 1 FROM "tmp_renumber"
WHERE "doc_type" IS NOT NULL GROUP BY 1, 2
ON CONFLICT ("doc_type", "period_key")
DO UPDATE SET "next_value" = GREATEST("number_sequences"."next_value", EXCLUDED."next_value");

-- The working tables end with this session; dropped here so the session can run more.
DROP TABLE "tmp_renumber";
DROP TABLE "tmp_starts";
DROP TABLE "tmp_old_bookings";
DROP TABLE "tmp_letters";
