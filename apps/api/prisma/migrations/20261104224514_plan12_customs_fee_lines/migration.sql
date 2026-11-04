-- Plan 12 section 5: an invoice line may bill one customs fee of its shipment. Nullable column,
-- its index and foreign key; existing lines stay unlinked. A fee billed on any invoice cannot be
-- removed from its customs file (RESTRICT).
ALTER TABLE "customer_invoice_lines" ADD COLUMN     "customs_fee_id" UUID;

-- CreateIndex
CREATE INDEX "customer_invoice_lines_customs_fee_id_idx" ON "customer_invoice_lines"("customs_fee_id");

-- AddForeignKey
ALTER TABLE "customer_invoice_lines" ADD CONSTRAINT "customer_invoice_lines_customs_fee_id_fkey" FOREIGN KEY ("customs_fee_id") REFERENCES "customs_fees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
