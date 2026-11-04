-- CreateEnum
CREATE TYPE "cs_receiver_account" AS ENUM ('CREATED', 'LINKED', 'PHONE_LOCAL', 'SAME_AS_SENDER', 'CUSTOMER_INACTIVE');

-- AlterTable
ALTER TABLE "cs_booking_requests" ADD COLUMN     "other_sender_customer_id" UUID,
ADD COLUMN     "other_sender_name" VARCHAR(200),
ADD COLUMN     "other_sender_phone" VARCHAR(20),
ADD COLUMN     "receiver_account" "cs_receiver_account",
ADD COLUMN     "receiver_customer_id" UUID;

-- AlterTable
ALTER TABLE "customers" ADD COLUMN     "phone_unverified" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "warehouse_movements" ADD COLUMN     "party_id_number" VARCHAR(50),
ADD COLUMN     "party_id_type" VARCHAR(50);

-- AddForeignKey
ALTER TABLE "cs_booking_requests" ADD CONSTRAINT "cs_booking_requests_other_sender_customer_id_fkey" FOREIGN KEY ("other_sender_customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cs_booking_requests" ADD CONSTRAINT "cs_booking_requests_receiver_customer_id_fkey" FOREIGN KEY ("receiver_customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
