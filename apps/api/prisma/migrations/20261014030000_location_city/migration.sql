-- AlterTable
ALTER TABLE "locations" ADD COLUMN     "city_id" UUID;

-- CreateIndex
CREATE INDEX "locations_city_id_idx" ON "locations"("city_id");

-- AddForeignKey
ALTER TABLE "locations" ADD CONSTRAINT "locations_city_id_fkey" FOREIGN KEY ("city_id") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
