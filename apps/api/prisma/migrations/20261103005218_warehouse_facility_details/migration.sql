-- CreateEnum
CREATE TYPE "warehouse_kind" AS ENUM ('COLLECTION_CENTER', 'DISTRIBUTION_HUB', 'DELIVERY_CENTER', 'DROP_OFF_POINT');

-- AlterTable
ALTER TABLE "warehouses" ADD COLUMN     "kind" "warehouse_kind",
ADD COLUMN     "latitude" DECIMAL(9,6),
ADD COLUMN     "longitude" DECIMAL(9,6),
ADD COLUMN     "phone" VARCHAR(20);
