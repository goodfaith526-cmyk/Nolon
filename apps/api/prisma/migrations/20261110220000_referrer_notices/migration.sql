-- Plan 18-3 (referral brokers): the broker's private link, his chat binding, and notices to him.
-- AlterEnum
ALTER TYPE "api_scope" ADD VALUE 'REFERRERS_LINK';

-- CreateTable
CREATE TABLE "referrer_link_tokens" (
    "id" UUID NOT NULL,
    "partner_id" UUID NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "used_at" TIMESTAMPTZ(3),
    "used_by_binding_id" UUID,
    "revoked_at" TIMESTAMPTZ(3),
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "referrer_link_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partner_channel_bindings" (
    "id" UUID NOT NULL,
    "partner_id" UUID NOT NULL,
    "api_client_id" UUID NOT NULL,
    "channel" VARCHAR(20) NOT NULL,
    "subject_id" VARCHAR(32) NOT NULL,
    "live_partner_channel" VARCHAR(80),
    "live_subject" VARCHAR(80),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ(3),
    "revoked_by_id" UUID,

    CONSTRAINT "partner_channel_bindings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cs_partner_notices" (
    "id" UUID NOT NULL,
    "api_client_id" UUID NOT NULL,
    "partner_id" UUID NOT NULL,
    "shipment_id" UUID NOT NULL,
    "type" VARCHAR(40) NOT NULL,
    "payload" JSONB NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(3) NOT NULL,
    "lease_until" TIMESTAMPTZ(3),
    "sent_at" TIMESTAMPTZ(3),
    "last_status" INTEGER,
    "last_error" VARCHAR(300),
    "undelivered_reason" VARCHAR(40),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cs_partner_notices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "referrer_link_tokens_token_hash_key" ON "referrer_link_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "referrer_link_tokens_partner_id_idx" ON "referrer_link_tokens"("partner_id");

-- CreateIndex
CREATE UNIQUE INDEX "partner_channel_bindings_live_partner_channel_key" ON "partner_channel_bindings"("live_partner_channel");

-- CreateIndex
CREATE UNIQUE INDEX "partner_channel_bindings_live_subject_key" ON "partner_channel_bindings"("live_subject");

-- CreateIndex
CREATE INDEX "partner_channel_bindings_partner_id_idx" ON "partner_channel_bindings"("partner_id");

-- CreateIndex
CREATE INDEX "cs_partner_notices_status_next_attempt_at_idx" ON "cs_partner_notices"("status", "next_attempt_at");

-- CreateIndex
CREATE UNIQUE INDEX "cs_partner_notices_type_shipment_id_partner_id_key" ON "cs_partner_notices"("type", "shipment_id", "partner_id");

-- AddForeignKey
ALTER TABLE "referrer_link_tokens" ADD CONSTRAINT "referrer_link_tokens_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referrer_link_tokens" ADD CONSTRAINT "referrer_link_tokens_used_by_binding_id_fkey" FOREIGN KEY ("used_by_binding_id") REFERENCES "partner_channel_bindings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referrer_link_tokens" ADD CONSTRAINT "referrer_link_tokens_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_channel_bindings" ADD CONSTRAINT "partner_channel_bindings_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_channel_bindings" ADD CONSTRAINT "partner_channel_bindings_api_client_id_fkey" FOREIGN KEY ("api_client_id") REFERENCES "api_clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_channel_bindings" ADD CONSTRAINT "partner_channel_bindings_revoked_by_id_fkey" FOREIGN KEY ("revoked_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cs_partner_notices" ADD CONSTRAINT "cs_partner_notices_api_client_id_fkey" FOREIGN KEY ("api_client_id") REFERENCES "api_clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cs_partner_notices" ADD CONSTRAINT "cs_partner_notices_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cs_partner_notices" ADD CONSTRAINT "cs_partner_notices_shipment_id_fkey" FOREIGN KEY ("shipment_id") REFERENCES "shipments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Plan 18, 5: a live binding has both live keys, each its own; a revoked one has neither.
ALTER TABLE "partner_channel_bindings" ADD CONSTRAINT "partner_channel_bindings_live_check" CHECK (
  ("revoked_at" IS NULL) = ("live_partner_channel" IS NOT NULL)
  AND ("live_partner_channel" IS NULL) = ("live_subject" IS NULL)
  AND ("live_partner_channel" IS NULL OR "live_partner_channel" = "partner_id"::text || ':' || "channel")
  AND ("live_subject" IS NULL OR "live_subject" = "channel" || ':' || "subject_id"));
ALTER TABLE "referrer_link_tokens" ADD CONSTRAINT "referrer_link_tokens_used_check" CHECK (("used_at" IS NULL) = ("used_by_binding_id" IS NULL));
