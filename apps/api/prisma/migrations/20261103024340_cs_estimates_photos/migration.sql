-- AlterEnum
ALTER TYPE "cs_booking_request_status" ADD VALUE 'ESTIMATED';

-- AlterTable
ALTER TABLE "cs_booking_requests" ADD COLUMN     "estimate_accepted_at" TIMESTAMPTZ(3),
ADD COLUMN     "estimate_accepted_version" INTEGER,
ADD COLUMN     "estimate_amount" DECIMAL(18,4),
ADD COLUMN     "estimate_currency" CHAR(3),
ADD COLUMN     "estimate_note_ar" VARCHAR(500),
ADD COLUMN     "estimate_note_en" VARCHAR(500),
ADD COLUMN     "estimate_valid_until" TIMESTAMPTZ(3),
ADD COLUMN     "estimate_version" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "estimated_at" TIMESTAMPTZ(3),
ADD COLUMN     "estimated_by_id" UUID;

-- CreateTable
CREATE TABLE "cs_booking_request_photos" (
    "id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "idempotency_key" VARCHAR(100) NOT NULL,
    "content_type" VARCHAR(20) NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "content" BYTEA NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cs_booking_request_photos_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "cs_booking_request_photos_request_id_idempotency_key_key" ON "cs_booking_request_photos"("request_id", "idempotency_key");

-- AddForeignKey
ALTER TABLE "cs_booking_request_photos" ADD CONSTRAINT "cs_booking_request_photos_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "cs_booking_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cs_booking_requests" ADD CONSTRAINT "cs_booking_requests_estimate_currency_fkey" FOREIGN KEY ("estimate_currency") REFERENCES "currencies"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cs_booking_requests" ADD CONSTRAINT "cs_booking_requests_estimated_by_id_fkey" FOREIGN KEY ("estimated_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Plan 09 section 12: only the image types read from the bytes, at most 10 MB, a hex SHA-256.
ALTER TABLE "cs_booking_request_photos" ADD CONSTRAINT "cs_booking_request_photos_type_check"
  CHECK ("content_type" IN ('image/jpeg', 'image/png', 'image/webp'));
ALTER TABLE "cs_booking_request_photos" ADD CONSTRAINT "cs_booking_request_photos_size_check"
  CHECK ("size_bytes" BETWEEN 1 AND 10485760 AND "size_bytes" = octet_length("content"));
ALTER TABLE "cs_booking_request_photos" ADD CONSTRAINT "cs_booking_request_photos_sha256_check"
  CHECK ("sha256" ~ '^[0-9a-f]{64}$');
