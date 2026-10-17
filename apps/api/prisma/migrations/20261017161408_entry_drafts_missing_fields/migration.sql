-- Entry drafts saved with missing values (owner decision): an assistant's trip, rate card,
-- quotation or booking draft is saved with only its key fields (branch, customer, trip kind);
-- a person fills in the rest on the review screen, and an approval is refused while anything the
-- record needs is missing. Only draft tables change: their value columns stop being NOT NULL. No
-- row is rewritten, and every existing row already satisfies the relaxed rules.

-- AlterTable
ALTER TABLE "booking_draft_items" ALTER COLUMN "cargo_type" DROP NOT NULL,
ALTER COLUMN "quantity" DROP NOT NULL;

-- AlterTable
ALTER TABLE "quotation_draft_lines" ALTER COLUMN "quantity" DROP NOT NULL;

-- AlterTable
ALTER TABLE "quotation_drafts" ALTER COLUMN "origin_location_id" DROP NOT NULL,
ALTER COLUMN "destination_location_id" DROP NOT NULL,
ALTER COLUMN "mode" DROP NOT NULL,
ALTER COLUMN "cargo_type" DROP NOT NULL,
ALTER COLUMN "currency" DROP NOT NULL,
ALTER COLUMN "valid_until" DROP NOT NULL;

-- AlterTable
ALTER TABLE "rate_card_drafts" ALTER COLUMN "origin_location_id" DROP NOT NULL,
ALTER COLUMN "destination_location_id" DROP NOT NULL,
ALTER COLUMN "mode" DROP NOT NULL,
ALTER COLUMN "cargo_type" DROP NOT NULL,
ALTER COLUMN "unit" DROP NOT NULL,
ALTER COLUMN "price" DROP NOT NULL,
ALTER COLUMN "currency" DROP NOT NULL,
ALTER COLUMN "valid_from" DROP NOT NULL;

-- AlterTable
ALTER TABLE "trip_drafts" ALTER COLUMN "origin_location_id" DROP NOT NULL,
ALTER COLUMN "destination_location_id" DROP NOT NULL;

-- A booking draft made from a quotation still carries no route or cargo of its own (they come
-- from the quotation on approval); a direct one may now be saved without them.
ALTER TABLE "booking_drafts" DROP CONSTRAINT "booking_drafts_source_check";
ALTER TABLE "booking_drafts" ADD CONSTRAINT "booking_drafts_source_check" CHECK (
  "source_quotation_id" IS NULL
  OR ("origin_location_id" IS NULL AND "destination_location_id" IS NULL AND "mode" IS NULL
      AND "load_type" IS NULL AND "cargo_type" IS NULL AND "cargo_description" IS NULL)
);
