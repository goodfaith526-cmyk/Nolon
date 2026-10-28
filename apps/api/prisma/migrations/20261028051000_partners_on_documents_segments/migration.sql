-- AlterTable
ALTER TABLE "booking_items" ADD COLUMN     "price_category_code" VARCHAR(20);

-- AlterTable
ALTER TABLE "customers" ADD COLUMN     "segment_code" VARCHAR(20);

-- AlterTable
ALTER TABLE "shipments" ADD COLUMN     "distributor_id" UUID,
ADD COLUMN     "origin_consolidator_id" UUID;

-- CreateIndex
CREATE INDEX "booking_items_price_category_code_idx" ON "booking_items"("price_category_code");

-- CreateIndex
CREATE INDEX "customers_segment_code_idx" ON "customers"("segment_code");

-- CreateIndex
CREATE INDEX "shipments_origin_consolidator_id_idx" ON "shipments"("origin_consolidator_id");

-- CreateIndex
CREATE INDEX "shipments_distributor_id_idx" ON "shipments"("distributor_id");

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_segment_code_fkey" FOREIGN KEY ("segment_code") REFERENCES "customer_segments"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking_items" ADD CONSTRAINT "booking_items_price_category_code_fkey" FOREIGN KEY ("price_category_code") REFERENCES "price_categories"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_origin_consolidator_id_fkey" FOREIGN KEY ("origin_consolidator_id") REFERENCES "partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_distributor_id_fkey" FOREIGN KEY ("distributor_id") REFERENCES "partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
