-- CreateTable
CREATE TABLE "party_drafts" (
    "id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "state" "entry_draft_state" NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 1,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "agent_client_id" UUID NOT NULL,
    "created_by_id" UUID NOT NULL,
    "idempotency_key" VARCHAR(100) NOT NULL,
    "payload_hash" CHAR(64) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "company_name" VARCHAR(200),
    "phone" VARCHAR(20),
    "email" VARCHAR(254),
    "country_code" CHAR(2),
    "city" VARCHAR(100),
    "address" VARCHAR(500),
    "party_id" UUID,
    "decided_by_id" UUID,
    "decided_at" TIMESTAMPTZ(3),
    "replaces_draft_id" UUID,
    "decided_via" "draft_decided_via",
    "reject_reason" VARCHAR(500),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "party_drafts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "party_drafts_party_id_key" ON "party_drafts"("party_id");

-- CreateIndex
CREATE INDEX "party_drafts_customer_id_state_idx" ON "party_drafts"("customer_id", "state");

-- CreateIndex
CREATE INDEX "party_drafts_branch_id_state_idx" ON "party_drafts"("branch_id", "state");

-- CreateIndex
CREATE INDEX "party_drafts_replaces_draft_id_idx" ON "party_drafts"("replaces_draft_id");

-- CreateIndex
CREATE UNIQUE INDEX "party_drafts_agent_client_id_created_by_id_idempotency_key_key" ON "party_drafts"("agent_client_id", "created_by_id", "idempotency_key");

-- AddForeignKey
ALTER TABLE "party_drafts" ADD CONSTRAINT "party_drafts_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "party_drafts" ADD CONSTRAINT "party_drafts_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "party_drafts" ADD CONSTRAINT "party_drafts_party_id_fkey" FOREIGN KEY ("party_id") REFERENCES "parties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "party_drafts" ADD CONSTRAINT "party_drafts_agent_client_id_fkey" FOREIGN KEY ("agent_client_id") REFERENCES "agent_clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "party_drafts" ADD CONSTRAINT "party_drafts_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "party_drafts" ADD CONSTRAINT "party_drafts_decided_by_id_fkey" FOREIGN KEY ("decided_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "party_drafts" ADD CONSTRAINT "party_drafts_decision_check" CHECK (
  ("state" = 'DRAFT' AND "decided_at" IS NULL AND "decided_by_id" IS NULL
     AND "decided_via" IS NULL AND "reject_reason" IS NULL AND "party_id" IS NULL)
  OR ("state" = 'APPROVED' AND "decided_at" IS NOT NULL AND "decided_by_id" IS NOT NULL
     AND "decided_via" = 'SESSION' AND "reject_reason" IS NULL AND "party_id" IS NOT NULL)
  OR ("state" = 'REJECTED' AND "decided_at" IS NOT NULL AND "decided_by_id" IS NOT NULL
     AND "decided_via" IS NOT NULL AND "reject_reason" IS NOT NULL AND "party_id" IS NULL)
);
ALTER TABLE "party_drafts" ADD CONSTRAINT "party_drafts_version_check" CHECK (
  "version" >= 1
);

-- A decided draft never changes again, whatever the application does. (The API has no delete;
-- removing a whole draft row is left to the retention purge and maintenance.)
CREATE FUNCTION "party_drafts_decided_immutable"() RETURNS trigger AS $$
BEGIN
  IF OLD."state" <> 'DRAFT' THEN
    RAISE EXCEPTION 'Party draft % is decided and cannot change', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "party_drafts_decided_immutable"
  BEFORE UPDATE ON "party_drafts"
  FOR EACH ROW EXECUTE FUNCTION "party_drafts_decided_immutable"();
