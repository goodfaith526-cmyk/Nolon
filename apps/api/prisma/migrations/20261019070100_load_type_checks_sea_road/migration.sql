-- FCL/LCL applies to every mode with a sea leg: SEA and SEA_ROAD. Written as "not ROAD" so the
-- check does not name the value the previous migration added (PostgreSQL refuses a new enum value
-- in the transaction that added it). Same rule as before for SEA and ROAD rows.
ALTER TABLE "rate_cards" DROP CONSTRAINT "rate_cards_load_type_check";
ALTER TABLE "rate_cards" ADD CONSTRAINT "rate_cards_load_type_check" CHECK (("mode" <> 'ROAD') OR ("load_type" IS NULL));

ALTER TABLE "quotations" DROP CONSTRAINT "quotations_load_type_check";
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_load_type_check" CHECK (("mode" <> 'ROAD') OR ("load_type" IS NULL));

ALTER TABLE "bookings" DROP CONSTRAINT "bookings_load_type_check";
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_load_type_check" CHECK (("mode" <> 'ROAD') OR ("load_type" IS NULL));

ALTER TABLE "shipments" DROP CONSTRAINT "shipments_load_type_check";
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_load_type_check" CHECK (("mode" <> 'ROAD') OR ("load_type" IS NULL));
