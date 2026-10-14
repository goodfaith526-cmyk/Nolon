-- CreateEnum
CREATE TYPE "draft_key_outcome" AS ENUM ('CREATED', 'NOT_CREATED');

-- CreateTable
CREATE TABLE "assistant_draft_keys" (
    "agent_client_id" UUID NOT NULL,
    "created_by_id" UUID NOT NULL,
    "draft_table" VARCHAR(50) NOT NULL,
    "idempotency_key" VARCHAR(100) NOT NULL,
    "outcome" "draft_key_outcome" NOT NULL,
    "draft_id" UUID,
    "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acked_at" TIMESTAMPTZ(6),

    CONSTRAINT "assistant_draft_keys_pkey" PRIMARY KEY ("agent_client_id","created_by_id","draft_table","idempotency_key")
);

-- CreateIndex
CREATE INDEX "assistant_draft_keys_acked_at_idx" ON "assistant_draft_keys"("acked_at");


-- A draft is named only with its outcome: CREATED carries the draft, NOT_CREATED none.
ALTER TABLE "assistant_draft_keys" ADD CONSTRAINT "assistant_draft_keys_outcome_check" CHECK (
    ("outcome" = 'CREATED' AND "draft_id" IS NOT NULL) OR ("outcome" = 'NOT_CREATED' AND "draft_id" IS NULL)
);
