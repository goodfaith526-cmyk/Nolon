-- Plan 18-4 (referral brokers): the broker's own login, and his attempts to add a customer.
-- AlterEnum
ALTER TYPE "role" ADD VALUE 'REFERRER_STAFF';

-- CreateTable
CREATE TABLE "referrer_customer_attempts" (
    "id" UUID NOT NULL,
    "partner_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "phone_end" VARCHAR(3) NOT NULL,
    "refused" BOOLEAN NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "referrer_customer_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "referrer_customer_attempts_partner_id_created_at_idx" ON "referrer_customer_attempts"("partner_id", "created_at");

-- AddForeignKey
ALTER TABLE "referrer_customer_attempts" ADD CONSTRAINT "referrer_customer_attempts_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referrer_customer_attempts" ADD CONSTRAINT "referrer_customer_attempts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
