-- ---------------------------------------------------------------------------------------------
-- Raw SQL, reviewed with the migration. Runs just before 20261027235016_route_numbers_renumbering.
--
-- That renumbering takes bookings numbered BK00001 (the format since the booking counter) and
-- gives each shipment its booking's number. Staging still holds bookings from before that format,
-- numbered NOL-BK-2026-000001: their shipments would take that number, which the renumbering's
-- checks refuse, so it failed on staging (2026-10-28, nothing changed: one transaction).
--
-- Here those bookings take the next BK numbers of the booking counter, in creation order, so the
-- renumbering then handles them like every other booking (LCL ones get their route number). Their
-- first numbers wait in "legacy_booking_numbers" until 20261028050000_log_legacy_booking_numbers
-- records them in the renumbering log (created by the renumbering) and drops that table, so staff
-- search still finds a booking by its first number. On a database without such bookings (every new
-- one) this changes no row. The whole file runs as one transaction.
-- ---------------------------------------------------------------------------------------------

CREATE TABLE "legacy_booking_numbers" AS
SELECT b."id", b."number" AS "old_number",
       s."start" + row_number() OVER (ORDER BY b."created_at", b."id") - 1 AS "serial"
FROM "bookings" b
CROSS JOIN (
    -- After the counter and after every BK number in use, whichever is higher.
    SELECT GREATEST(
        COALESCE((SELECT "next_value" FROM "number_sequences"
                  WHERE "doc_type" = 'BOOKING' AND "period_key" = ''), 1),
        COALESCE((SELECT max(substring("number" FROM 3)::bigint) + 1 FROM "bookings"
                  WHERE "number" ~ '^BK[0-9]+$'), 1)
    ) AS "start"
) s
WHERE b."number" ~ '^NOL-BK-';

UPDATE "bookings" b
SET "number" = 'BK' || lpad(t."serial"::text, greatest(5, length(t."serial"::text)), '0')
FROM "legacy_booking_numbers" t
WHERE b."id" = t."id";

-- The booking counter continues after the numbers given here.
INSERT INTO "number_sequences" ("doc_type", "period_key", "next_value")
SELECT 'BOOKING', '', max("serial") + 1 FROM "legacy_booking_numbers" HAVING count(*) > 0
ON CONFLICT ("doc_type", "period_key")
DO UPDATE SET "next_value" = GREATEST("number_sequences"."next_value", EXCLUDED."next_value");
