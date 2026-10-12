-- CreateTable
CREATE TABLE "new_customer_booking_drafts" (
    "id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "state" "entry_draft_state" NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 1,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "agent_client_id" UUID NOT NULL,
    "created_by_id" UUID NOT NULL,
    "idempotency_key" VARCHAR(100) NOT NULL,
    "payload_hash" CHAR(64) NOT NULL,
    "evidence" JSONB NOT NULL DEFAULT '[]',
    "customer_draft_id" UUID NOT NULL,
    "request" JSONB NOT NULL,
    "booking_id" UUID,
    "decided_by_id" UUID,
    "decided_at" TIMESTAMPTZ(3),
    "replaces_draft_id" UUID,
    "decided_via" "draft_decided_via",
    "reject_reason" VARCHAR(500),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "new_customer_booking_drafts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "new_customer_booking_drafts_customer_draft_id_key" ON "new_customer_booking_drafts"("customer_draft_id");

-- CreateIndex
CREATE UNIQUE INDEX "new_customer_booking_drafts_booking_id_key" ON "new_customer_booking_drafts"("booking_id");

-- CreateIndex
CREATE INDEX "new_customer_booking_drafts_branch_id_state_idx" ON "new_customer_booking_drafts"("branch_id", "state");

-- CreateIndex
CREATE INDEX "new_customer_booking_drafts_replaces_draft_id_idx" ON "new_customer_booking_drafts"("replaces_draft_id");

-- CreateIndex
CREATE UNIQUE INDEX "new_customer_booking_drafts_agent_client_id_created_by_id_i_key" ON "new_customer_booking_drafts"("agent_client_id", "created_by_id", "idempotency_key");

-- AddForeignKey
ALTER TABLE "new_customer_booking_drafts" ADD CONSTRAINT "new_customer_booking_drafts_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "new_customer_booking_drafts" ADD CONSTRAINT "new_customer_booking_drafts_customer_draft_id_fkey" FOREIGN KEY ("customer_draft_id") REFERENCES "customer_drafts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "new_customer_booking_drafts" ADD CONSTRAINT "new_customer_booking_drafts_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "new_customer_booking_drafts" ADD CONSTRAINT "new_customer_booking_drafts_agent_client_id_fkey" FOREIGN KEY ("agent_client_id") REFERENCES "agent_clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "new_customer_booking_drafts" ADD CONSTRAINT "new_customer_booking_drafts_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "new_customer_booking_drafts" ADD CONSTRAINT "new_customer_booking_drafts_decided_by_id_fkey" FOREIGN KEY ("decided_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "new_customer_booking_drafts" ADD CONSTRAINT "new_customer_booking_drafts_decision_check" CHECK (
  ("state" = 'DRAFT' AND "decided_at" IS NULL AND "decided_by_id" IS NULL
     AND "decided_via" IS NULL AND "reject_reason" IS NULL AND "booking_id" IS NULL)
  OR ("state" = 'APPROVED' AND "decided_at" IS NOT NULL AND "decided_by_id" IS NOT NULL
     AND "decided_via" = 'SESSION' AND "reject_reason" IS NULL AND "booking_id" IS NOT NULL)
  OR ("state" = 'REJECTED' AND "decided_at" IS NOT NULL AND "decided_by_id" IS NOT NULL
     AND "decided_via" IS NOT NULL AND "reject_reason" IS NOT NULL AND "booking_id" IS NULL)
);
-- The words are a JSON array (drafts/draft-evidence.ts); the booking is a JSON object.
ALTER TABLE "new_customer_booking_drafts" ADD CONSTRAINT "new_customer_booking_drafts_evidence_check" CHECK (
  jsonb_typeof("evidence") = 'array'
);
ALTER TABLE "new_customer_booking_drafts" ADD CONSTRAINT "new_customer_booking_drafts_request_check" CHECK (
  jsonb_typeof("request") = 'object'
);
ALTER TABLE "new_customer_booking_drafts" ADD CONSTRAINT "new_customer_booking_drafts_version_check" CHECK (
  "version" >= 1
);

-- A decided draft never changes again, whatever the application does. (The API has no delete;
-- removing a whole draft row is left to the retention purge and maintenance.)
CREATE FUNCTION "new_customer_booking_drafts_decided_immutable"() RETURNS trigger AS $$
BEGIN
  IF OLD."state" <> 'DRAFT' THEN
    RAISE EXCEPTION 'New customer booking draft % is decided and cannot change', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "new_customer_booking_drafts_decided_immutable"
  BEFORE UPDATE ON "new_customer_booking_drafts"
  FOR EACH ROW EXECUTE FUNCTION "new_customer_booking_drafts_decided_immutable"();
