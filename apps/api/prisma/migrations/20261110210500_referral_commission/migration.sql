-- Plan 18-2 (referral brokers): the REFERRER commission role and each shipment's referral facts.
-- CreateEnum
CREATE TYPE "referrer_reason" AS ENUM ('FIRST_SHIPMENT', 'BROUGHT_IN_PERSON');

-- AlterEnum
ALTER TYPE "commission_role" ADD VALUE 'REFERRER';

-- CreateTable
CREATE TABLE "shipment_referrals" (
    "shipment_id" UUID NOT NULL,
    "brought_by_partner_id" UUID,
    "referrer_id" UUID,
    "referrer_reason" "referrer_reason",
    "first_for_customer_id" UUID,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "shipment_referrals_pkey" PRIMARY KEY ("shipment_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "shipment_referrals_first_for_customer_id_key" ON "shipment_referrals"("first_for_customer_id");

-- CreateIndex
CREATE INDEX "shipment_referrals_brought_by_partner_id_idx" ON "shipment_referrals"("brought_by_partner_id");

-- CreateIndex
CREATE INDEX "shipment_referrals_referrer_id_idx" ON "shipment_referrals"("referrer_id");

-- AddForeignKey
ALTER TABLE "shipment_referrals" ADD CONSTRAINT "shipment_referrals_shipment_id_fkey" FOREIGN KEY ("shipment_id") REFERENCES "shipments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_referrals" ADD CONSTRAINT "shipment_referrals_brought_by_partner_id_fkey" FOREIGN KEY ("brought_by_partner_id") REFERENCES "partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_referrals" ADD CONSTRAINT "shipment_referrals_referrer_id_fkey" FOREIGN KEY ("referrer_id") REFERENCES "partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_referrals" ADD CONSTRAINT "shipment_referrals_first_for_customer_id_fkey" FOREIGN KEY ("first_for_customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Plan 18, 4.1: the slot is both set or both null; a shipment holding a customer's first pays it as
-- FIRST_SHIPMENT.
ALTER TABLE "shipment_referrals" ADD CONSTRAINT "shipment_referrals_slot_check" CHECK (("referrer_id" IS NULL) = ("referrer_reason" IS NULL));
ALTER TABLE "shipment_referrals" ADD CONSTRAINT "shipment_referrals_first_check" CHECK ("first_for_customer_id" IS NULL OR "referrer_reason" = 'FIRST_SHIPMENT');
