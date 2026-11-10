-- Plan 18-1 (referral brokers): a partner kind, a code table, and nullable links on customers.

-- AlterEnum
ALTER TYPE "partner_kind" ADD VALUE 'REFERRER';

-- AlterTable
ALTER TABLE "customers" ADD COLUMN     "referral_first_shipment_id" UUID,
ADD COLUMN     "referred_at" TIMESTAMPTZ(3),
ADD COLUMN     "referred_by_partner_id" UUID;

-- AlterTable
ALTER TABLE "partners" ADD COLUMN     "referral_window_days" INTEGER;

-- CreateTable
CREATE TABLE "referral_codes" (
    "code" VARCHAR(16) NOT NULL,
    "partner_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retired_at" TIMESTAMPTZ(3),

    CONSTRAINT "referral_codes_pkey" PRIMARY KEY ("code")
);

-- CreateIndex
CREATE INDEX "referral_codes_partner_id_idx" ON "referral_codes"("partner_id");

-- CreateIndex
CREATE INDEX "customers_referred_by_partner_id_idx" ON "customers"("referred_by_partner_id");

-- CreateIndex
CREATE INDEX "customers_referral_first_shipment_id_idx" ON "customers"("referral_first_shipment_id");

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_referred_by_partner_id_fkey" FOREIGN KEY ("referred_by_partner_id") REFERENCES "partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_referral_first_shipment_id_fkey" FOREIGN KEY ("referral_first_shipment_id") REFERENCES "shipments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referral_codes" ADD CONSTRAINT "referral_codes_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Plan 18, 3: one live code per referrer; a code is `r_` + 8 of [a-z0-9].
CREATE UNIQUE INDEX "referral_codes_one_live_per_partner" ON "referral_codes"("partner_id") WHERE "retired_at" IS NULL;
ALTER TABLE "referral_codes" ADD CONSTRAINT "referral_codes_code_check" CHECK ("code" ~ '^r_[a-z0-9]{8}$');
