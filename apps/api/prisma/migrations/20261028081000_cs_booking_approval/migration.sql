-- AlterTable
ALTER TABLE "cs_booking_requests" ADD COLUMN     "booking_id" UUID,
ADD COLUMN     "payment_currency" CHAR(3);

-- CreateIndex
CREATE INDEX "cs_booking_requests_booking_id_idx" ON "cs_booking_requests"("booking_id");

-- AddForeignKey
ALTER TABLE "cs_booking_requests" ADD CONSTRAINT "cs_booking_requests_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cs_booking_requests" ADD CONSTRAINT "cs_booking_requests_payment_currency_fkey" FOREIGN KEY ("payment_currency") REFERENCES "currencies"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "cs_booking_requests" ADD COLUMN     "approved_category_code" VARCHAR(20),
ADD COLUMN     "approved_currency" CHAR(3),
ADD COLUMN     "approved_quantity" DECIMAL(18,4),
ADD COLUMN     "approved_total" DECIMAL(18,4);

-- AddForeignKey
ALTER TABLE "cs_booking_requests" ADD CONSTRAINT "cs_booking_requests_approved_category_code_fkey" FOREIGN KEY ("approved_category_code") REFERENCES "price_categories"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cs_booking_requests" ADD CONSTRAINT "cs_booking_requests_approved_currency_fkey" FOREIGN KEY ("approved_currency") REFERENCES "currencies"("code") ON DELETE RESTRICT ON UPDATE CASCADE;
