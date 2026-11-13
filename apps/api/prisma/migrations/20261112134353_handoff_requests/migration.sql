-- CreateEnum
CREATE TYPE "cs_handoff_status" AS ENUM ('OPEN', 'CONTACTED');

-- AlterEnum
ALTER TYPE "alert_kind" ADD VALUE 'HANDOFF_REQUEST_OPEN';

-- AlterEnum
ALTER TYPE "api_scope" ADD VALUE 'HANDOFF_REQUESTS_CREATE';

-- CreateTable
CREATE TABLE "cs_handoff_requests" (
    "id" UUID NOT NULL,
    "number" VARCHAR(20) NOT NULL,
    "api_client_id" UUID NOT NULL,
    "idempotency_key" VARCHAR(100) NOT NULL,
    "content_hash" CHAR(64) NOT NULL,
    "channel" VARCHAR(20) NOT NULL,
    "sender_id" VARCHAR(64) NOT NULL,
    "customer_name" VARCHAR(200),
    "customer_phone" VARCHAR(20),
    "reason" VARCHAR(300) NOT NULL,
    "booking_request_ref" VARCHAR(20),
    "branch_hint" VARCHAR(100),
    "branch_id" UUID,
    "allowed_branch_ids" UUID[],
    "status" "cs_handoff_status" NOT NULL DEFAULT 'OPEN',
    "contacted_by_id" UUID,
    "contacted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cs_handoff_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "cs_handoff_requests_number_key" ON "cs_handoff_requests"("number");

-- CreateIndex
CREATE INDEX "cs_handoff_requests_status_branch_id_idx" ON "cs_handoff_requests"("status", "branch_id");

-- CreateIndex
CREATE UNIQUE INDEX "cs_handoff_requests_api_client_id_idempotency_key_key" ON "cs_handoff_requests"("api_client_id", "idempotency_key");

-- AddForeignKey
ALTER TABLE "cs_handoff_requests" ADD CONSTRAINT "cs_handoff_requests_api_client_id_fkey" FOREIGN KEY ("api_client_id") REFERENCES "api_clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cs_handoff_requests" ADD CONSTRAINT "cs_handoff_requests_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cs_handoff_requests" ADD CONSTRAINT "cs_handoff_requests_contacted_by_id_fkey" FOREIGN KEY ("contacted_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
