-- AlterEnum
ALTER TYPE "cs_booking_request_status" ADD VALUE 'CANCELLED';

-- AlterTable
ALTER TABLE "cs_booking_requests" ADD COLUMN     "cancel_reason" VARCHAR(300),
ADD COLUMN     "cancel_request_closed_at" TIMESTAMPTZ(3),
ADD COLUMN     "cancel_request_closed_by_id" UUID,
ADD COLUMN     "cancel_request_reason" VARCHAR(300),
ADD COLUMN     "cancel_requested_at" TIMESTAMPTZ(3),
ADD COLUMN     "cancelled_at" TIMESTAMPTZ(3);

-- AddForeignKey
ALTER TABLE "cs_booking_requests" ADD CONSTRAINT "cs_booking_requests_cancel_request_closed_by_id_fkey" FOREIGN KEY ("cancel_request_closed_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
