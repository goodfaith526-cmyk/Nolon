-- AlterTable
ALTER TABLE "cs_booking_requests" ADD COLUMN     "conversation_id" VARCHAR(128),
ADD COLUMN     "profile_id" UUID;

-- AlterTable
ALTER TABLE "customers" ADD COLUMN     "profile_id" UUID,
ALTER COLUMN "phone" DROP NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "customers_profile_id_branch_id_key" ON "customers"("profile_id", "branch_id");

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "customer_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cs_booking_requests" ADD CONSTRAINT "cs_booking_requests_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "customer_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
