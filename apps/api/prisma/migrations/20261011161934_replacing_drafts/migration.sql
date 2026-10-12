-- AlterTable
ALTER TABLE "booking_drafts" ADD COLUMN     "replaces_draft_id" UUID;

-- AlterTable
ALTER TABLE "customer_drafts" ADD COLUMN     "replaces_draft_id" UUID;

-- AlterTable
ALTER TABLE "goods_release_drafts" ADD COLUMN     "replaces_draft_id" UUID;

-- AlterTable
ALTER TABLE "invoice_drafts" ADD COLUMN     "replaces_draft_id" UUID;

-- AlterTable
ALTER TABLE "quotation_drafts" ADD COLUMN     "replaces_draft_id" UUID;

-- AlterTable
ALTER TABLE "receipt_drafts" ADD COLUMN     "replaces_draft_id" UUID;

-- AlterTable
ALTER TABLE "trip_drafts" ADD COLUMN     "replaces_draft_id" UUID;

-- CreateIndex
CREATE INDEX "booking_drafts_replaces_draft_id_idx" ON "booking_drafts"("replaces_draft_id");

-- CreateIndex
CREATE INDEX "customer_drafts_replaces_draft_id_idx" ON "customer_drafts"("replaces_draft_id");

-- CreateIndex
CREATE INDEX "goods_release_drafts_replaces_draft_id_idx" ON "goods_release_drafts"("replaces_draft_id");

-- CreateIndex
CREATE INDEX "invoice_drafts_replaces_draft_id_idx" ON "invoice_drafts"("replaces_draft_id");

-- CreateIndex
CREATE INDEX "quotation_drafts_replaces_draft_id_idx" ON "quotation_drafts"("replaces_draft_id");

-- CreateIndex
CREATE INDEX "receipt_drafts_replaces_draft_id_idx" ON "receipt_drafts"("replaces_draft_id");

-- CreateIndex
CREATE INDEX "trip_drafts_replaces_draft_id_idx" ON "trip_drafts"("replaces_draft_id");
