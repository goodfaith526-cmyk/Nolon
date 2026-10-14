-- CreateEnum
CREATE TYPE "draft_price_source" AS ENUM ('TYPED', 'QUOTATION', 'RATE_CARD');

-- AlterTable
ALTER TABLE "invoice_draft_lines" ADD COLUMN     "price_source" "draft_price_source" NOT NULL DEFAULT 'TYPED',
ADD COLUMN     "rate_card_id" UUID;

-- CreateIndex
CREATE INDEX "invoice_draft_lines_rate_card_id_idx" ON "invoice_draft_lines"("rate_card_id");

-- AddForeignKey
ALTER TABLE "invoice_draft_lines" ADD CONSTRAINT "invoice_draft_lines_rate_card_id_fkey" FOREIGN KEY ("rate_card_id") REFERENCES "rate_cards"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
