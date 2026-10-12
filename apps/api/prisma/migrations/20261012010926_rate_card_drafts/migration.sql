-- CreateTable
CREATE TABLE "rate_card_drafts" (
    "id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "state" "entry_draft_state" NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 1,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "agent_client_id" UUID NOT NULL,
    "created_by_id" UUID NOT NULL,
    "idempotency_key" VARCHAR(100) NOT NULL,
    "payload_hash" CHAR(64) NOT NULL,
    "origin_location_id" UUID NOT NULL,
    "destination_location_id" UUID NOT NULL,
    "mode" "shipping_mode" NOT NULL,
    "load_type" "load_type",
    "cargo_type" "cargo_type" NOT NULL,
    "container_type_code" VARCHAR(10),
    "charge_type_code" VARCHAR(20),
    "unit" "rate_unit" NOT NULL,
    "price" DECIMAL(18,4) NOT NULL,
    "minimum_charge" DECIMAL(18,4),
    "currency" CHAR(3) NOT NULL,
    "valid_from" DATE NOT NULL,
    "valid_to" DATE,
    "transit_days" INTEGER,
    "notes" VARCHAR(2000),
    "rate_card_id" UUID,
    "decided_by_id" UUID,
    "decided_at" TIMESTAMPTZ(3),
    "replaces_draft_id" UUID,
    "decided_via" "draft_decided_via",
    "reject_reason" VARCHAR(500),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "rate_card_drafts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "rate_card_drafts_rate_card_id_key" ON "rate_card_drafts"("rate_card_id");

-- CreateIndex
CREATE INDEX "rate_card_drafts_branch_id_state_idx" ON "rate_card_drafts"("branch_id", "state");

-- CreateIndex
CREATE INDEX "rate_card_drafts_replaces_draft_id_idx" ON "rate_card_drafts"("replaces_draft_id");

-- CreateIndex
CREATE UNIQUE INDEX "rate_card_drafts_agent_client_id_created_by_id_idempotency__key" ON "rate_card_drafts"("agent_client_id", "created_by_id", "idempotency_key");

-- AddForeignKey
ALTER TABLE "rate_card_drafts" ADD CONSTRAINT "rate_card_drafts_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_card_drafts" ADD CONSTRAINT "rate_card_drafts_rate_card_id_fkey" FOREIGN KEY ("rate_card_id") REFERENCES "rate_cards"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_card_drafts" ADD CONSTRAINT "rate_card_drafts_agent_client_id_fkey" FOREIGN KEY ("agent_client_id") REFERENCES "agent_clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_card_drafts" ADD CONSTRAINT "rate_card_drafts_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_card_drafts" ADD CONSTRAINT "rate_card_drafts_decided_by_id_fkey" FOREIGN KEY ("decided_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "rate_card_drafts" ADD CONSTRAINT "rate_card_drafts_decision_check" CHECK (
  ("state" = 'DRAFT' AND "decided_at" IS NULL AND "decided_by_id" IS NULL
     AND "decided_via" IS NULL AND "reject_reason" IS NULL AND "rate_card_id" IS NULL)
  OR ("state" = 'APPROVED' AND "decided_at" IS NOT NULL AND "decided_by_id" IS NOT NULL
     AND "decided_via" = 'SESSION' AND "reject_reason" IS NULL AND "rate_card_id" IS NOT NULL)
  OR ("state" = 'REJECTED' AND "decided_at" IS NOT NULL AND "decided_by_id" IS NOT NULL
     AND "decided_via" IS NOT NULL AND "reject_reason" IS NOT NULL AND "rate_card_id" IS NULL)
);
ALTER TABLE "rate_card_drafts" ADD CONSTRAINT "rate_card_drafts_version_check" CHECK (
  "version" >= 1
);
ALTER TABLE "rate_card_drafts" ADD CONSTRAINT "rate_card_drafts_amounts_check" CHECK (
  "price" >= 0 AND ("minimum_charge" IS NULL OR "minimum_charge" >= 0)
);

-- A decided draft never changes again, whatever the application does. (The API has no delete;
-- removing a whole draft row is left to the retention purge and maintenance.)
CREATE FUNCTION "rate_card_drafts_decided_immutable"() RETURNS trigger AS $$
BEGIN
  IF OLD."state" <> 'DRAFT' THEN
    RAISE EXCEPTION 'Rate card draft % is decided and cannot change', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "rate_card_drafts_decided_immutable"
  BEFORE UPDATE ON "rate_card_drafts"
  FOR EACH ROW EXECUTE FUNCTION "rate_card_drafts_decided_immutable"();
