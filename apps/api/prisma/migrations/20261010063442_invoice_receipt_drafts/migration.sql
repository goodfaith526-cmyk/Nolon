-- CreateTable
CREATE TABLE "invoice_drafts" (
    "id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "shipment_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "state" "entry_draft_state" NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 1,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "agent_client_id" UUID NOT NULL,
    "created_by_id" UUID NOT NULL,
    "idempotency_key" VARCHAR(100) NOT NULL,
    "payload_hash" CHAR(64) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "invoice_date" DATE NOT NULL,
    "due_date" DATE NOT NULL,
    "notes" VARCHAR(2000),
    "decided_by_id" UUID,
    "decided_at" TIMESTAMPTZ(3),
    "reject_reason" VARCHAR(500),
    "invoice_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "invoice_drafts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_draft_lines" (
    "draft_id" UUID NOT NULL,
    "line_no" INTEGER NOT NULL,
    "charge_type_code" VARCHAR(20) NOT NULL,
    "description" VARCHAR(500),
    "quantity" DECIMAL(18,4) NOT NULL,
    "unit_price" DECIMAL(18,4) NOT NULL,

    CONSTRAINT "invoice_draft_lines_pkey" PRIMARY KEY ("draft_id","line_no")
);

-- CreateTable
CREATE TABLE "receipt_drafts" (
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
    "receipt_date" DATE NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "amount" DECIMAL(18,4) NOT NULL,
    "cash_account_id" UUID NOT NULL,
    "reference" VARCHAR(100),
    "notes" VARCHAR(2000),
    "decided_by_id" UUID,
    "decided_at" TIMESTAMPTZ(3),
    "reject_reason" VARCHAR(500),
    "receipt_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "receipt_drafts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "receipt_draft_allocations" (
    "draft_id" UUID NOT NULL,
    "line_no" INTEGER NOT NULL,
    "invoice_id" UUID NOT NULL,
    "amount" DECIMAL(18,4) NOT NULL,

    CONSTRAINT "receipt_draft_allocations_pkey" PRIMARY KEY ("draft_id","line_no")
);

-- CreateIndex
CREATE UNIQUE INDEX "invoice_drafts_invoice_id_key" ON "invoice_drafts"("invoice_id");

-- CreateIndex
CREATE INDEX "invoice_drafts_branch_id_state_idx" ON "invoice_drafts"("branch_id", "state");

-- CreateIndex
CREATE INDEX "invoice_drafts_shipment_id_idx" ON "invoice_drafts"("shipment_id");

-- CreateIndex
CREATE UNIQUE INDEX "invoice_drafts_agent_client_id_created_by_id_idempotency_ke_key" ON "invoice_drafts"("agent_client_id", "created_by_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "receipt_drafts_receipt_id_key" ON "receipt_drafts"("receipt_id");

-- CreateIndex
CREATE INDEX "receipt_drafts_branch_id_state_idx" ON "receipt_drafts"("branch_id", "state");

-- CreateIndex
CREATE INDEX "receipt_drafts_customer_id_idx" ON "receipt_drafts"("customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "receipt_drafts_agent_client_id_created_by_id_idempotency_ke_key" ON "receipt_drafts"("agent_client_id", "created_by_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "receipt_draft_allocations_invoice_id_idx" ON "receipt_draft_allocations"("invoice_id");

-- CreateIndex
CREATE UNIQUE INDEX "receipt_draft_allocations_draft_id_invoice_id_key" ON "receipt_draft_allocations"("draft_id", "invoice_id");

-- AddForeignKey
ALTER TABLE "invoice_drafts" ADD CONSTRAINT "invoice_drafts_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_drafts" ADD CONSTRAINT "invoice_drafts_shipment_id_fkey" FOREIGN KEY ("shipment_id") REFERENCES "shipments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_drafts" ADD CONSTRAINT "invoice_drafts_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_drafts" ADD CONSTRAINT "invoice_drafts_agent_client_id_fkey" FOREIGN KEY ("agent_client_id") REFERENCES "agent_clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_drafts" ADD CONSTRAINT "invoice_drafts_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_drafts" ADD CONSTRAINT "invoice_drafts_decided_by_id_fkey" FOREIGN KEY ("decided_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_drafts" ADD CONSTRAINT "invoice_drafts_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "customer_invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_draft_lines" ADD CONSTRAINT "invoice_draft_lines_draft_id_fkey" FOREIGN KEY ("draft_id") REFERENCES "invoice_drafts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipt_drafts" ADD CONSTRAINT "receipt_drafts_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipt_drafts" ADD CONSTRAINT "receipt_drafts_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipt_drafts" ADD CONSTRAINT "receipt_drafts_cash_account_id_fkey" FOREIGN KEY ("cash_account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipt_drafts" ADD CONSTRAINT "receipt_drafts_agent_client_id_fkey" FOREIGN KEY ("agent_client_id") REFERENCES "agent_clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipt_drafts" ADD CONSTRAINT "receipt_drafts_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipt_drafts" ADD CONSTRAINT "receipt_drafts_decided_by_id_fkey" FOREIGN KEY ("decided_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipt_drafts" ADD CONSTRAINT "receipt_drafts_receipt_id_fkey" FOREIGN KEY ("receipt_id") REFERENCES "receipts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipt_draft_allocations" ADD CONSTRAINT "receipt_draft_allocations_draft_id_fkey" FOREIGN KEY ("draft_id") REFERENCES "receipt_drafts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipt_draft_allocations" ADD CONSTRAINT "receipt_draft_allocations_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "customer_invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A draft's decision fields agree with its state: only an approval carries its result, only a
-- rejection a reason, and an open draft carries neither.
ALTER TABLE "invoice_drafts" ADD CONSTRAINT "invoice_drafts_decision_check" CHECK (
  ("state" = 'DRAFT' AND "decided_at" IS NULL AND "decided_by_id" IS NULL
     AND "invoice_id" IS NULL AND "reject_reason" IS NULL)
  OR ("state" = 'APPROVED' AND "decided_at" IS NOT NULL AND "decided_by_id" IS NOT NULL
     AND "invoice_id" IS NOT NULL AND "reject_reason" IS NULL)
  OR ("state" = 'REJECTED' AND "decided_at" IS NOT NULL AND "decided_by_id" IS NOT NULL
     AND "invoice_id" IS NULL AND "reject_reason" IS NOT NULL)
);
ALTER TABLE "invoice_drafts" ADD CONSTRAINT "invoice_drafts_version_check" CHECK ("version" >= 1);
ALTER TABLE "invoice_drafts" ADD CONSTRAINT "invoice_drafts_dates_check" CHECK (
  "due_date" >= "invoice_date"
);
ALTER TABLE "invoice_draft_lines" ADD CONSTRAINT "invoice_draft_lines_amounts_check" CHECK (
  "quantity" > 0 AND "unit_price" >= 0
);

ALTER TABLE "receipt_drafts" ADD CONSTRAINT "receipt_drafts_decision_check" CHECK (
  ("state" = 'DRAFT' AND "decided_at" IS NULL AND "decided_by_id" IS NULL
     AND "receipt_id" IS NULL AND "reject_reason" IS NULL)
  OR ("state" = 'APPROVED' AND "decided_at" IS NOT NULL AND "decided_by_id" IS NOT NULL
     AND "receipt_id" IS NOT NULL AND "reject_reason" IS NULL)
  OR ("state" = 'REJECTED' AND "decided_at" IS NOT NULL AND "decided_by_id" IS NOT NULL
     AND "receipt_id" IS NULL AND "reject_reason" IS NOT NULL)
);
ALTER TABLE "receipt_drafts" ADD CONSTRAINT "receipt_drafts_version_check" CHECK ("version" >= 1);
ALTER TABLE "receipt_drafts" ADD CONSTRAINT "receipt_drafts_amount_check" CHECK ("amount" > 0);
ALTER TABLE "receipt_draft_allocations" ADD CONSTRAINT "receipt_draft_allocations_amount_check"
  CHECK ("amount" > 0);

-- A decided draft never changes again, whatever the application does. (The API has no delete;
-- removing a whole draft row is left to maintenance, e.g. test cleanup.)
CREATE FUNCTION "invoice_drafts_decided_immutable"() RETURNS trigger AS $$
BEGIN
  IF OLD."state" <> 'DRAFT' THEN
    RAISE EXCEPTION 'Invoice draft % is decided and cannot change', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "invoice_drafts_decided_immutable"
  BEFORE UPDATE ON "invoice_drafts"
  FOR EACH ROW EXECUTE FUNCTION "invoice_drafts_decided_immutable"();

CREATE FUNCTION "receipt_drafts_decided_immutable"() RETURNS trigger AS $$
BEGIN
  IF OLD."state" <> 'DRAFT' THEN
    RAISE EXCEPTION 'Receipt draft % is decided and cannot change', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "receipt_drafts_decided_immutable"
  BEFORE UPDATE ON "receipt_drafts"
  FOR EACH ROW EXECUTE FUNCTION "receipt_drafts_decided_immutable"();

-- The lines of a decided invoice draft never change, nor move to another draft.
CREATE FUNCTION "invoice_draft_lines_open_draft_only"() RETURNS trigger AS $$
DECLARE
  draft_state "entry_draft_state";
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."draft_id" <> OLD."draft_id" THEN
    RAISE EXCEPTION 'An invoice draft line cannot move to another draft'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT "state" INTO draft_state FROM "invoice_drafts"
    WHERE "id" = CASE WHEN TG_OP = 'DELETE' THEN OLD."draft_id" ELSE NEW."draft_id" END;
  -- No draft row: its lines are going with it (ON DELETE CASCADE).
  IF FOUND AND draft_state <> 'DRAFT' THEN
    RAISE EXCEPTION 'The lines of a decided invoice draft cannot change'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "invoice_draft_lines_open_draft_only"
  BEFORE INSERT OR UPDATE OR DELETE ON "invoice_draft_lines"
  FOR EACH ROW EXECUTE FUNCTION "invoice_draft_lines_open_draft_only"();

-- The allocations of a decided receipt draft never change, nor move to another draft.
CREATE FUNCTION "receipt_draft_allocations_open_draft_only"() RETURNS trigger AS $$
DECLARE
  draft_state "entry_draft_state";
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."draft_id" <> OLD."draft_id" THEN
    RAISE EXCEPTION 'A receipt draft allocation cannot move to another draft'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT "state" INTO draft_state FROM "receipt_drafts"
    WHERE "id" = CASE WHEN TG_OP = 'DELETE' THEN OLD."draft_id" ELSE NEW."draft_id" END;
  -- No draft row: its allocations are going with it (ON DELETE CASCADE).
  IF FOUND AND draft_state <> 'DRAFT' THEN
    RAISE EXCEPTION 'The allocations of a decided receipt draft cannot change'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "receipt_draft_allocations_open_draft_only"
  BEFORE INSERT OR UPDATE OR DELETE ON "receipt_draft_allocations"
  FOR EACH ROW EXECUTE FUNCTION "receipt_draft_allocations_open_draft_only"();
