-- CreateTable
CREATE TABLE "customer_drafts" (
    "id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "state" "entry_draft_state" NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 1,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "agent_client_id" UUID NOT NULL,
    "created_by_id" UUID NOT NULL,
    "idempotency_key" VARCHAR(100) NOT NULL,
    "payload_hash" CHAR(64) NOT NULL,
    "kind" "customer_kind" NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "company_name" VARCHAR(200),
    "phone" VARCHAR(20) NOT NULL,
    "whatsapp" VARCHAR(20),
    "email" VARCHAR(254),
    "city" VARCHAR(100),
    "address" VARCHAR(500),
    "notes" VARCHAR(2000),
    "decided_by_id" UUID,
    "decided_at" TIMESTAMPTZ(3),
    "decided_via" "draft_decided_via",
    "reject_reason" VARCHAR(500),
    "customer_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "customer_drafts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "customer_drafts_customer_id_key" ON "customer_drafts"("customer_id");

-- CreateIndex
CREATE INDEX "customer_drafts_branch_id_state_idx" ON "customer_drafts"("branch_id", "state");

-- CreateIndex
CREATE UNIQUE INDEX "customer_drafts_agent_client_id_created_by_id_idempotency_k_key" ON "customer_drafts"("agent_client_id", "created_by_id", "idempotency_key");

-- AddForeignKey
ALTER TABLE "customer_drafts" ADD CONSTRAINT "customer_drafts_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_drafts" ADD CONSTRAINT "customer_drafts_agent_client_id_fkey" FOREIGN KEY ("agent_client_id") REFERENCES "agent_clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_drafts" ADD CONSTRAINT "customer_drafts_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_drafts" ADD CONSTRAINT "customer_drafts_decided_by_id_fkey" FOREIGN KEY ("decided_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_drafts" ADD CONSTRAINT "customer_drafts_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A draft's decision fields agree with its state: only an approval carries the customer it
-- created, only a rejection a reason, and an open draft carries neither. A customer draft is
-- decided on the review screen only (it is not among the kinds the assistant's chat decides).
ALTER TABLE "customer_drafts" ADD CONSTRAINT "customer_drafts_decision_check" CHECK (
  ("state" = 'DRAFT' AND "decided_at" IS NULL AND "decided_by_id" IS NULL
     AND "decided_via" IS NULL AND "customer_id" IS NULL AND "reject_reason" IS NULL)
  OR ("state" = 'APPROVED' AND "decided_at" IS NOT NULL AND "decided_by_id" IS NOT NULL
     AND "decided_via" = 'SESSION' AND "customer_id" IS NOT NULL AND "reject_reason" IS NULL)
  OR ("state" = 'REJECTED' AND "decided_at" IS NOT NULL AND "decided_by_id" IS NOT NULL
     AND "decided_via" = 'SESSION' AND "customer_id" IS NULL AND "reject_reason" IS NOT NULL)
);
ALTER TABLE "customer_drafts" ADD CONSTRAINT "customer_drafts_version_check" CHECK (
  "version" >= 1
);
ALTER TABLE "customer_drafts" ADD CONSTRAINT "customer_drafts_values_check" CHECK (
  btrim("name") <> '' AND btrim("phone") <> ''
);

-- A decided draft never changes again, whatever the application does. (The API has no delete;
-- removing a whole draft row is left to the retention purge and maintenance.)
CREATE FUNCTION "customer_drafts_decided_immutable"() RETURNS trigger AS $$
BEGIN
  IF OLD."state" <> 'DRAFT' THEN
    RAISE EXCEPTION 'Customer draft % is decided and cannot change', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "customer_drafts_decided_immutable"
  BEFORE UPDATE ON "customer_drafts"
  FOR EACH ROW EXECUTE FUNCTION "customer_drafts_decided_immutable"();
