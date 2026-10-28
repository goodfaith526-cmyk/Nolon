-- CreateEnum
CREATE TYPE "price_source" AS ENUM ('RATE_CARD', 'TYPED');

-- AlterEnum
ALTER TYPE "location_kind" ADD VALUE 'COUNTRY';

-- AlterTable
ALTER TABLE "quotation_lines" ADD COLUMN     "price_category_code" VARCHAR(20),
ADD COLUMN     "price_source" "price_source",
ADD COLUMN     "price_source_snapshot" JSONB;

-- AlterTable
ALTER TABLE "rate_cards" ADD COLUMN     "price_category_code" VARCHAR(20);

-- CreateIndex
CREATE INDEX "quotation_lines_price_category_code_idx" ON "quotation_lines"("price_category_code");

-- CreateIndex
CREATE INDEX "rate_cards_price_category_code_idx" ON "rate_cards"("price_category_code");

-- AddForeignKey
ALTER TABLE "rate_cards" ADD CONSTRAINT "rate_cards_price_category_code_fkey" FOREIGN KEY ("price_category_code") REFERENCES "price_categories"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotation_lines" ADD CONSTRAINT "quotation_lines_price_category_code_fkey" FOREIGN KEY ("price_category_code") REFERENCES "price_categories"("code") ON DELETE RESTRICT ON UPDATE CASCADE;
