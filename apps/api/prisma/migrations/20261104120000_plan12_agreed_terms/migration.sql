-- Plan 12, section 1: the agreed terms pinned on the booking. Additive: new type, nullable or
-- constant-defaulted columns, an index, a unique index and foreign keys on the new columns.

-- CreateEnum
CREATE TYPE "quotation_source" AS ENUM ('STAFF', 'BOT_REQUEST');

-- AlterTable
ALTER TABLE "quotations" ADD COLUMN "cs_request_id" UUID,
ADD COLUMN "source" "quotation_source" NOT NULL DEFAULT 'STAFF';

-- AlterTable
ALTER TABLE "quotation_lines" ADD COLUMN "booking_item_id" UUID,
ADD COLUMN "covers_all_items" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "bookings" ADD COLUMN "agreed_terms_hash" CHAR(64),
ADD COLUMN "agreed_terms_version" INTEGER;

-- CreateIndex
CREATE UNIQUE INDEX "quotations_cs_request_id_key" ON "quotations"("cs_request_id");

-- CreateIndex
CREATE INDEX "quotation_lines_booking_item_id_idx" ON "quotation_lines"("booking_item_id");

-- AddForeignKey
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_cs_request_id_fkey" FOREIGN KEY ("cs_request_id") REFERENCES "cs_booking_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotation_lines" ADD CONSTRAINT "quotation_lines_booking_item_id_fkey" FOREIGN KEY ("booking_item_id") REFERENCES "booking_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Plan 12 section 7: the alert for a confirmed shipment with no approved main invoice.
ALTER TYPE "alert_kind" ADD VALUE 'SHIPMENT_NOT_INVOICED';
