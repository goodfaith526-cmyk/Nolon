-- ---------------------------------------------------------------------------------------------
-- Raw SQL, reviewed with the migration. The bookings 20261027235015_legacy_booking_numbers took
-- off their first numbers (NOL-BK-2026-000001) go into the renumbering log with the number they
-- carry now, so staff search finds them by their first number. Then its working table goes.
-- On a database that had no such bookings this inserts nothing.
-- ---------------------------------------------------------------------------------------------

INSERT INTO "reference_renumberings" ("kind", "record_id", "old_number", "new_number", "reason")
SELECT 'BOOKING', b."id", l."old_number", b."number", 'MIGRATION'
FROM "legacy_booking_numbers" l
JOIN "bookings" b ON b."id" = l."id"
ORDER BY b."id";

DROP TABLE "legacy_booking_numbers";
