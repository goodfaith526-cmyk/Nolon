-- CreateEnum
CREATE TYPE "cs_booking_request_status" AS ENUM ('AWAITING_ROUTING', 'PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "cs_handover" AS ENUM ('PICKUP', 'BRANCH_DROP');

-- CreateTable
CREATE TABLE "cs_booking_requests" (
    "id" UUID NOT NULL,
    "reference" VARCHAR(20) NOT NULL,
    "api_client_id" UUID NOT NULL,
    "owner_ref" VARCHAR(200) NOT NULL,
    "customer_id" UUID,
    "grant_id" VARCHAR(41),
    "sender_channel" VARCHAR(20),
    "sender_id" VARCHAR(64),
    "contact_phone" VARCHAR(20),
    "idempotency_key" VARCHAR(100) NOT NULL,
    "content_hash" CHAR(64) NOT NULL,
    "status" "cs_booking_request_status" NOT NULL,
    "branch_id" UUID,
    "allowed_branch_ids" UUID[],
    "origin_location_id" UUID,
    "destination_location_id" UUID,
    "price_category_code" VARCHAR(20),
    "bot_names" JSONB,
    "quantity" DECIMAL(18,4) NOT NULL,
    "services" "booking_service"[],
    "sender_name" VARCHAR(200) NOT NULL,
    "consignee_name" VARCHAR(200) NOT NULL,
    "consignee_phone" VARCHAR(20) NOT NULL,
    "handover" "cs_handover" NOT NULL,
    "requested_date" DATE,
    "quote_ref" VARCHAR(40),
    "bot_quoted_amount" DECIMAL(18,4),
    "bot_quoted_currency" CHAR(3),
    "language" VARCHAR(2),
    "version" INTEGER NOT NULL DEFAULT 1,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "cs_booking_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "cs_booking_requests_reference_key" ON "cs_booking_requests"("reference");

-- CreateIndex
CREATE INDEX "cs_booking_requests_owner_ref_created_at_idx" ON "cs_booking_requests"("owner_ref", "created_at");

-- CreateIndex
CREATE INDEX "cs_booking_requests_branch_id_status_idx" ON "cs_booking_requests"("branch_id", "status");

-- CreateIndex
CREATE INDEX "cs_booking_requests_status_idx" ON "cs_booking_requests"("status");

-- CreateIndex
CREATE UNIQUE INDEX "cs_booking_requests_api_client_id_owner_ref_idempotency_key_key" ON "cs_booking_requests"("api_client_id", "owner_ref", "idempotency_key");

-- AddForeignKey
ALTER TABLE "cs_booking_requests" ADD CONSTRAINT "cs_booking_requests_api_client_id_fkey" FOREIGN KEY ("api_client_id") REFERENCES "api_clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cs_booking_requests" ADD CONSTRAINT "cs_booking_requests_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cs_booking_requests" ADD CONSTRAINT "cs_booking_requests_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cs_booking_requests" ADD CONSTRAINT "cs_booking_requests_origin_location_id_fkey" FOREIGN KEY ("origin_location_id") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cs_booking_requests" ADD CONSTRAINT "cs_booking_requests_destination_location_id_fkey" FOREIGN KEY ("destination_location_id") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cs_booking_requests" ADD CONSTRAINT "cs_booking_requests_price_category_code_fkey" FOREIGN KEY ("price_category_code") REFERENCES "price_categories"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cs_booking_requests" ADD CONSTRAINT "cs_booking_requests_quote_ref_fkey" FOREIGN KEY ("quote_ref") REFERENCES "cs_quotes"("ref") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Exactly one owner: a customer (through a customer token) or a channel identity.
ALTER TABLE "cs_booking_requests" ADD CONSTRAINT "cs_booking_requests_one_owner_check"
    CHECK (("customer_id" IS NULL) <> ("sender_channel" IS NULL)
        AND ("sender_channel" IS NULL) = ("sender_id" IS NULL)
        AND ("customer_id" IS NULL) = ("grant_id" IS NULL));

-- A request awaiting routing has no branch; any other has one.
ALTER TABLE "cs_booking_requests" ADD CONSTRAINT "cs_booking_requests_branch_check"
    CHECK (("status" = 'AWAITING_ROUTING') = ("branch_id" IS NULL));

ALTER TABLE "cs_booking_requests" ADD CONSTRAINT "cs_booking_requests_quantity_check"
    CHECK ("quantity" > 0);

-- A request by ids names its route, type and language; one by names (the bot's own words) keeps
-- them, and the ids it matched, if any, for staff to complete.
ALTER TABLE "cs_booking_requests" ADD CONSTRAINT "cs_booking_requests_form_check"
    CHECK ("bot_names" IS NOT NULL
        OR ("origin_location_id" IS NOT NULL AND "destination_location_id" IS NOT NULL
            AND "price_category_code" IS NOT NULL AND "language" IS NOT NULL));

-- The price the bot says it showed: both parts or neither, never negative, never a price of record.
ALTER TABLE "cs_booking_requests" ADD CONSTRAINT "cs_booking_requests_bot_quoted_check"
    CHECK (("bot_quoted_amount" IS NULL) = ("bot_quoted_currency" IS NULL)
        AND ("bot_quoted_amount" IS NULL OR "bot_quoted_amount" >= 0));
