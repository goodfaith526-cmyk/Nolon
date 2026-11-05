-- AlterEnum
ALTER TYPE "quotation_source" ADD VALUE 'BOT_QUOTE';

-- AlterTable
ALTER TABLE "quotations" ADD COLUMN     "created_via_api_client_id" UUID;

-- CreateTable
CREATE TABLE "cs_quote_saves" (
    "quote_ref" VARCHAR(40) NOT NULL,
    "quotation_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cs_quote_saves_pkey" PRIMARY KEY ("quote_ref")
);

-- CreateIndex
CREATE INDEX "cs_quote_saves_quotation_id_idx" ON "cs_quote_saves"("quotation_id");

-- AddForeignKey
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_created_via_api_client_id_fkey" FOREIGN KEY ("created_via_api_client_id") REFERENCES "api_clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cs_quote_saves" ADD CONSTRAINT "cs_quote_saves_quote_ref_fkey" FOREIGN KEY ("quote_ref") REFERENCES "cs_quotes"("ref") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cs_quote_saves" ADD CONSTRAINT "cs_quote_saves_quotation_id_fkey" FOREIGN KEY ("quotation_id") REFERENCES "quotations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
