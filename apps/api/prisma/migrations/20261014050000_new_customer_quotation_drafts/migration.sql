-- CreateTable
CREATE TABLE "new_customer_quotation_drafts" (
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
    "customer" JSONB NOT NULL,
    "origin_location_id" UUID NOT NULL,
    "destination_location_id" UUID NOT NULL,
    "mode" "shipping_mode" NOT NULL,
    "load_type" "load_type",
    "cargo_type" "cargo_type" NOT NULL,
    "cargo_description" VARCHAR(2000),
    "currency" CHAR(3) NOT NULL,
    "valid_until" DATE NOT NULL,
    "terms" VARCHAR(4000),
    "customer_id" UUID,
    "quotation_id" UUID,
    "decided_by_id" UUID,
    "decided_at" TIMESTAMPTZ(3),
    "replaces_draft_id" UUID,
    "decided_via" "draft_decided_via",
    "reject_reason" VARCHAR(500),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "new_customer_quotation_drafts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "new_customer_quotation_draft_lines" (
    "draft_id" UUID NOT NULL,
    "line_no" INTEGER NOT NULL,
    "rate_card_id" UUID,
    "charge_type_code" VARCHAR(20),
    "description" VARCHAR(500),
    "unit" "rate_unit",
    "quantity" DECIMAL(18,4) NOT NULL,
    "unit_price" DECIMAL(18,4),
    "discount" DECIMAL(18,4),

    CONSTRAINT "new_customer_quotation_draft_lines_pkey" PRIMARY KEY ("draft_id","line_no")
);

-- CreateIndex
CREATE UNIQUE INDEX "new_customer_quotation_drafts_customer_id_key" ON "new_customer_quotation_drafts"("customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "new_customer_quotation_drafts_quotation_id_key" ON "new_customer_quotation_drafts"("quotation_id");

-- CreateIndex
CREATE INDEX "new_customer_quotation_drafts_branch_id_state_idx" ON "new_customer_quotation_drafts"("branch_id", "state");

-- CreateIndex
CREATE INDEX "new_customer_quotation_drafts_replaces_draft_id_idx" ON "new_customer_quotation_drafts"("replaces_draft_id");

-- CreateIndex
CREATE UNIQUE INDEX "new_customer_quotation_drafts_agent_client_id_created_by_id_key" ON "new_customer_quotation_drafts"("agent_client_id", "created_by_id", "idempotency_key");

-- AddForeignKey
ALTER TABLE "new_customer_quotation_drafts" ADD CONSTRAINT "new_customer_quotation_drafts_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "new_customer_quotation_drafts" ADD CONSTRAINT "new_customer_quotation_drafts_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "new_customer_quotation_drafts" ADD CONSTRAINT "new_customer_quotation_drafts_quotation_id_fkey" FOREIGN KEY ("quotation_id") REFERENCES "quotations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "new_customer_quotation_drafts" ADD CONSTRAINT "new_customer_quotation_drafts_agent_client_id_fkey" FOREIGN KEY ("agent_client_id") REFERENCES "agent_clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "new_customer_quotation_drafts" ADD CONSTRAINT "new_customer_quotation_drafts_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "new_customer_quotation_drafts" ADD CONSTRAINT "new_customer_quotation_drafts_decided_by_id_fkey" FOREIGN KEY ("decided_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "new_customer_quotation_draft_lines" ADD CONSTRAINT "new_customer_quotation_draft_lines_draft_id_fkey" FOREIGN KEY ("draft_id") REFERENCES "new_customer_quotation_drafts"("id") ON DELETE CASCADE ON UPDATE CASCADE;


ALTER TABLE "new_customer_quotation_drafts" ADD CONSTRAINT "new_customer_quotation_drafts_decision_check" CHECK (
  ("state" = 'DRAFT' AND "decided_at" IS NULL AND "decided_by_id" IS NULL
     AND "decided_via" IS NULL AND "reject_reason" IS NULL
     AND "customer_id" IS NULL AND "quotation_id" IS NULL)
  OR ("state" = 'APPROVED' AND "decided_at" IS NOT NULL AND "decided_by_id" IS NOT NULL
     AND "decided_via" = 'SESSION' AND "reject_reason" IS NULL
     AND "customer_id" IS NOT NULL AND "quotation_id" IS NOT NULL)
  OR ("state" = 'REJECTED' AND "decided_at" IS NOT NULL AND "decided_by_id" IS NOT NULL
     AND "decided_via" IS NOT NULL AND "reject_reason" IS NOT NULL
     AND "customer_id" IS NULL AND "quotation_id" IS NULL)
);
-- The words are a JSON array (drafts/draft-evidence.ts); the customer is a JSON object.
ALTER TABLE "new_customer_quotation_drafts" ADD CONSTRAINT "new_customer_quotation_drafts_evidence_check" CHECK (
  jsonb_typeof("evidence") = 'array'
);
ALTER TABLE "new_customer_quotation_drafts" ADD CONSTRAINT "new_customer_quotation_drafts_customer_check" CHECK (
  jsonb_typeof("customer") = 'object'
);
ALTER TABLE "new_customer_quotation_drafts" ADD CONSTRAINT "new_customer_quotation_drafts_version_check" CHECK (
  "version" >= 1
);
ALTER TABLE "new_customer_quotation_draft_lines" ADD CONSTRAINT "new_customer_quotation_draft_lines_line_no_check" CHECK (
  "line_no" >= 1
);

-- A decided draft never changes again, whatever the application does. (The API has no delete;
-- removing a whole draft row is left to the retention purge and maintenance.)
CREATE FUNCTION "new_customer_quotation_drafts_decided_immutable"() RETURNS trigger AS $$
BEGIN
  IF OLD."state" <> 'DRAFT' THEN
    RAISE EXCEPTION 'New customer quotation draft % is decided and cannot change', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "new_customer_quotation_drafts_decided_immutable"
  BEFORE UPDATE ON "new_customer_quotation_drafts"
  FOR EACH ROW EXECUTE FUNCTION "new_customer_quotation_drafts_decided_immutable"();
