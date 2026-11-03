-- AlterTable
ALTER TABLE "cs_booking_requests" ADD COLUMN     "event_seq" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "last_stage_code" VARCHAR(30);

-- CreateTable
CREATE TABLE "cs_webhook_endpoints" (
    "id" UUID NOT NULL,
    "api_client_id" UUID NOT NULL,
    "url" VARCHAR(500) NOT NULL,
    "audience" VARCHAR(100) NOT NULL,
    "status" VARCHAR(10) NOT NULL,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approved_by_id" UUID,
    "approved_at" TIMESTAMPTZ(3),
    "retired_by_id" UUID,
    "retired_at" TIMESTAMPTZ(3),
    "approved_key" UUID,

    CONSTRAINT "cs_webhook_endpoints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cs_outbox" (
    "id" UUID NOT NULL,
    "api_client_id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "type" VARCHAR(40) NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(3) NOT NULL,
    "lease_until" TIMESTAMPTZ(3),
    "sent_at" TIMESTAMPTZ(3),
    "last_status" INTEGER,
    "last_error" VARCHAR(300),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cs_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "cs_webhook_endpoints_approved_key_key" ON "cs_webhook_endpoints"("approved_key");

-- CreateIndex
CREATE INDEX "cs_webhook_endpoints_api_client_id_status_idx" ON "cs_webhook_endpoints"("api_client_id", "status");

-- CreateIndex
CREATE INDEX "cs_outbox_status_next_attempt_at_idx" ON "cs_outbox"("status", "next_attempt_at");

-- CreateIndex
CREATE UNIQUE INDEX "cs_outbox_request_id_sequence_key" ON "cs_outbox"("request_id", "sequence");

-- AddForeignKey
ALTER TABLE "cs_webhook_endpoints" ADD CONSTRAINT "cs_webhook_endpoints_api_client_id_fkey" FOREIGN KEY ("api_client_id") REFERENCES "api_clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cs_webhook_endpoints" ADD CONSTRAINT "cs_webhook_endpoints_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cs_webhook_endpoints" ADD CONSTRAINT "cs_webhook_endpoints_approved_by_id_fkey" FOREIGN KEY ("approved_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cs_webhook_endpoints" ADD CONSTRAINT "cs_webhook_endpoints_retired_by_id_fkey" FOREIGN KEY ("retired_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cs_outbox" ADD CONSTRAINT "cs_outbox_api_client_id_fkey" FOREIGN KEY ("api_client_id") REFERENCES "api_clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cs_outbox" ADD CONSTRAINT "cs_outbox_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "cs_booking_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Plan 09 section 5: endpoint states, approval by someone other than the creator, one approved
-- endpoint per key (approved_key is the key exactly while APPROVED), and the outbox states. An
-- approved endpoint names its approver; one retired while still pending has none (F172-2).
ALTER TABLE "cs_webhook_endpoints" ADD CONSTRAINT "cs_webhook_endpoints_status_check"
  CHECK ("status" IN ('PENDING', 'APPROVED', 'RETIRED'));
ALTER TABLE "cs_webhook_endpoints" ADD CONSTRAINT "cs_webhook_endpoints_approver_check"
  CHECK ("approved_by_id" IS NULL OR "approved_by_id" <> "created_by_id");
ALTER TABLE "cs_webhook_endpoints" ADD CONSTRAINT "cs_webhook_endpoints_approved_check"
  CHECK (("status" = 'APPROVED') = ("approved_key" IS NOT NULL)
    AND ("approved_key" IS NULL OR "approved_key" = "api_client_id")
    AND ("status" <> 'APPROVED' OR "approved_by_id" IS NOT NULL));
ALTER TABLE "cs_webhook_endpoints" ADD CONSTRAINT "cs_webhook_endpoints_url_check"
  CHECK ("url" LIKE 'https://%');
ALTER TABLE "cs_outbox" ADD CONSTRAINT "cs_outbox_status_check"
  CHECK ("status" IN ('PENDING', 'SENDING', 'SENT', 'FAILED', 'CANCELLED_BY_POLICY'));
ALTER TABLE "cs_outbox" ADD CONSTRAINT "cs_outbox_sequence_check" CHECK ("sequence" >= 1);
