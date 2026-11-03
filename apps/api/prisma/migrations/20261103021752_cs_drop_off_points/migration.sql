-- AlterTable
ALTER TABLE "branches" ADD COLUMN     "support_phone" VARCHAR(20);

-- AlterTable
ALTER TABLE "cs_booking_requests" ADD COLUMN     "drop_off_warehouse_id" UUID;

-- AlterTable
ALTER TABLE "warehouses" ADD COLUMN     "accepts_drop_off" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "address_en" VARCHAR(500),
ADD COLUMN     "hours_ar" VARCHAR(200),
ADD COLUMN     "hours_en" VARCHAR(200),
ADD COLUMN     "map_url" VARCHAR(500),
ADD COLUMN     "partner_id" UUID;

-- AddForeignKey
ALTER TABLE "warehouses" ADD CONSTRAINT "warehouses_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cs_booking_requests" ADD CONSTRAINT "cs_booking_requests_drop_off_warehouse_id_fkey" FOREIGN KEY ("drop_off_warehouse_id") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
