-- AlterTable
ALTER TABLE "cs_quotes" ADD COLUMN     "pieces" INTEGER,
ADD COLUMN     "length_cm" DECIMAL(10,2),
ADD COLUMN     "width_cm" DECIMAL(10,2),
ADD COLUMN     "height_cm" DECIMAL(10,2);

-- AlterTable
ALTER TABLE "cs_booking_requests" ADD COLUMN     "pieces" INTEGER,
ADD COLUMN     "length_cm" DECIMAL(10,2),
ADD COLUMN     "width_cm" DECIMAL(10,2),
ADD COLUMN     "height_cm" DECIMAL(10,2);
