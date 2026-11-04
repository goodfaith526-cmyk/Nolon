-- AlterTable
ALTER TABLE "api_clients" ADD COLUMN     "offers_last_mile" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "offers_pickup" BOOLEAN NOT NULL DEFAULT true;
