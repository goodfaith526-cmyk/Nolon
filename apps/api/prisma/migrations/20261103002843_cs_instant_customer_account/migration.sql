-- CreateEnum
CREATE TYPE "cs_instant_account" AS ENUM ('CREATED', 'REUSED', 'PROFILE_REVIEW', 'NAME_MISSING', 'PROFILE_CHANGED', 'PHONE_IN_USE', 'ACCOUNT_INACTIVE');

-- AlterTable
ALTER TABLE "cs_booking_requests" ADD COLUMN     "instant_account" "cs_instant_account",
ADD COLUMN     "instant_customer_id" UUID;

-- AlterTable
ALTER TABLE "customers" ADD COLUMN     "created_via_api_client_id" UUID,
ALTER COLUMN "created_by_id" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_created_via_api_client_id_fkey" FOREIGN KEY ("created_via_api_client_id") REFERENCES "api_clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cs_booking_requests" ADD CONSTRAINT "cs_booking_requests_instant_customer_id_fkey" FOREIGN KEY ("instant_customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- An account is made by a staff member or, from a signed bot request, by the bot's key: never by
-- no one. Every existing row has created_by_id, so the check holds on them.
ALTER TABLE "customers" ADD CONSTRAINT "customers_created_by_check"
    CHECK ("created_by_id" IS NOT NULL OR "created_via_api_client_id" IS NOT NULL);

-- The request names the account exactly when one was made or reused.
ALTER TABLE "cs_booking_requests" ADD CONSTRAINT "cs_booking_requests_instant_account_check"
    CHECK (("instant_customer_id" IS NOT NULL) = ("instant_account" IS NOT NULL AND "instant_account" IN ('CREATED', 'REUSED')));
