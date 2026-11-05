-- AlterTable
ALTER TABLE "bookings" ADD COLUMN     "drop_off_warehouse_id" UUID;

-- CreateIndex
CREATE INDEX "bookings_drop_off_warehouse_id_idx" ON "bookings"("drop_off_warehouse_id");

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_drop_off_warehouse_id_fkey" FOREIGN KEY ("drop_off_warehouse_id") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
