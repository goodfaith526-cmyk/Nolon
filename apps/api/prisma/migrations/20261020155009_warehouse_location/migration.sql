-- AlterTable
ALTER TABLE "warehouses" ADD COLUMN     "location_id" UUID;

-- CreateIndex
CREATE INDEX "warehouses_location_id_idx" ON "warehouses"("location_id");

-- AddForeignKey
ALTER TABLE "warehouses" ADD CONSTRAINT "warehouses_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
