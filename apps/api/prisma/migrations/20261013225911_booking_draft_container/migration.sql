-- AlterTable
ALTER TABLE "booking_drafts" ADD COLUMN     "consolidation_id" UUID;

-- CreateIndex
CREATE INDEX "booking_drafts_consolidation_id_idx" ON "booking_drafts"("consolidation_id");

-- AddForeignKey
ALTER TABLE "booking_drafts" ADD CONSTRAINT "booking_drafts_consolidation_id_fkey" FOREIGN KEY ("consolidation_id") REFERENCES "consolidations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
