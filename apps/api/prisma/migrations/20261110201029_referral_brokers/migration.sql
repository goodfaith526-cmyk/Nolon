-- Plan 18-1 (referral brokers): a partner kind, a code table, and nullable links on customers and profiles.
-- AlterEnum
ALTER TYPE "partner_kind" ADD VALUE 'REFERRER';

-- AlterTable
ALTER TABLE "customer_profiles" ADD COLUMN     "referral_partner_id" UUID;

-- AlterTable
ALTER TABLE "customers" ADD COLUMN     "referred_at" TIMESTAMPTZ(3),
ADD COLUMN     "referred_by_partner_id" UUID;

-- AlterTable
ALTER TABLE "partners" ADD COLUMN     "referral_window_days" INTEGER;

-- CreateTable
CREATE TABLE "referral_codes" (
    "code" VARCHAR(16) NOT NULL,
    "partner_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retired_at" TIMESTAMPTZ(3),
    "live_partner_id" UUID,

    CONSTRAINT "referral_codes_pkey" PRIMARY KEY ("code")
);

-- CreateIndex
CREATE UNIQUE INDEX "referral_codes_live_partner_id_key" ON "referral_codes"("live_partner_id");

-- CreateIndex
CREATE INDEX "referral_codes_partner_id_idx" ON "referral_codes"("partner_id");

-- CreateIndex
CREATE INDEX "customer_profiles_referral_partner_id_idx" ON "customer_profiles"("referral_partner_id");

-- CreateIndex
CREATE INDEX "customers_referred_by_partner_id_idx" ON "customers"("referred_by_partner_id");

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_referred_by_partner_id_fkey" FOREIGN KEY ("referred_by_partner_id") REFERENCES "partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referral_codes" ADD CONSTRAINT "referral_codes_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_profiles" ADD CONSTRAINT "customer_profiles_referral_partner_id_fkey" FOREIGN KEY ("referral_partner_id") REFERENCES "partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Plan 18, 3: one live code per referrer (live_partner_id is unique and set exactly while the code
-- is live, to its own partner); a code is `r_` + 8 of [a-z0-9].
ALTER TABLE "referral_codes" ADD CONSTRAINT "referral_codes_live_check" CHECK (("retired_at" IS NULL) = ("live_partner_id" IS NOT NULL) AND ("live_partner_id" IS NULL OR "live_partner_id" = "partner_id"));
ALTER TABLE "referral_codes" ADD CONSTRAINT "referral_codes_code_check" CHECK ("code" ~ '^r_[a-z0-9]{8}$');
