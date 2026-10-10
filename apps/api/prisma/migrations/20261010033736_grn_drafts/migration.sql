-- CreateEnum
CREATE TYPE "grn_draft_state" AS ENUM ('DRAFT', 'APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "grn_drafts" (
    "id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "shipment_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "document_sha256" CHAR(64) NOT NULL,
    "state" "grn_draft_state" NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 1,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "agent_client_id" UUID NOT NULL,
    "created_by_id" UUID NOT NULL,
    "idempotency_key" VARCHAR(100) NOT NULL,
    "payload_hash" CHAR(64) NOT NULL,
    "stated_packages" INTEGER,
    "stated_gross_kg" DECIMAL(12,3),
    "stated_net_kg" DECIMAL(12,3),
    "stated_cbm" DECIMAL(12,3),
    "warnings" VARCHAR(40)[],
    "decided_by_id" UUID,
    "decided_at" TIMESTAMPTZ(3),
    "reject_reason" VARCHAR(500),
    "movement_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "grn_drafts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "grn_draft_lines" (
    "draft_id" UUID NOT NULL,
    "line_no" INTEGER NOT NULL,
    "branch_id" UUID NOT NULL,
    "marks" VARCHAR(200),
    "description" VARCHAR(500),
    "package_count" INTEGER,
    "package_type" VARCHAR(50),
    "quantity" DECIMAL(14,3),
    "unit" VARCHAR(20),
    "gross_kg" DECIMAL(12,3),
    "net_kg" DECIMAL(12,3),
    "cbm" DECIMAL(12,3),
    "source_page" INTEGER,
    "source_row" INTEGER,
    "field_meta" JSONB NOT NULL,

    CONSTRAINT "grn_draft_lines_pkey" PRIMARY KEY ("draft_id","line_no")
);

-- CreateIndex
CREATE UNIQUE INDEX "grn_drafts_movement_id_key" ON "grn_drafts"("movement_id");

-- CreateIndex
CREATE INDEX "grn_drafts_shipment_id_idx" ON "grn_drafts"("shipment_id");

-- CreateIndex
CREATE INDEX "grn_drafts_branch_id_idx" ON "grn_drafts"("branch_id");

-- CreateIndex
CREATE UNIQUE INDEX "grn_drafts_agent_client_id_created_by_id_idempotency_key_key" ON "grn_drafts"("agent_client_id", "created_by_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "grn_draft_lines_branch_id_idx" ON "grn_draft_lines"("branch_id");

-- AddForeignKey
ALTER TABLE "grn_drafts" ADD CONSTRAINT "grn_drafts_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grn_drafts" ADD CONSTRAINT "grn_drafts_shipment_id_fkey" FOREIGN KEY ("shipment_id") REFERENCES "shipments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grn_drafts" ADD CONSTRAINT "grn_drafts_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grn_drafts" ADD CONSTRAINT "grn_drafts_agent_client_id_fkey" FOREIGN KEY ("agent_client_id") REFERENCES "agent_clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grn_drafts" ADD CONSTRAINT "grn_drafts_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grn_drafts" ADD CONSTRAINT "grn_drafts_decided_by_id_fkey" FOREIGN KEY ("decided_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grn_drafts" ADD CONSTRAINT "grn_drafts_movement_id_fkey" FOREIGN KEY ("movement_id") REFERENCES "warehouse_movements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grn_draft_lines" ADD CONSTRAINT "grn_draft_lines_draft_id_fkey" FOREIGN KEY ("draft_id") REFERENCES "grn_drafts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grn_draft_lines" ADD CONSTRAINT "grn_draft_lines_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A draft's decision fields agree with its state: only an approval carries a GRN, only a
-- rejection a reason, and an open draft carries neither.
ALTER TABLE "grn_drafts" ADD CONSTRAINT "grn_drafts_decision_check" CHECK (
  ("state" = 'DRAFT' AND "decided_at" IS NULL AND "decided_by_id" IS NULL
     AND "movement_id" IS NULL AND "reject_reason" IS NULL)
  OR ("state" = 'APPROVED' AND "decided_at" IS NOT NULL AND "decided_by_id" IS NOT NULL
     AND "movement_id" IS NOT NULL AND "reject_reason" IS NULL)
  OR ("state" = 'REJECTED' AND "decided_at" IS NOT NULL AND "decided_by_id" IS NOT NULL
     AND "movement_id" IS NULL AND "reject_reason" IS NOT NULL)
);

ALTER TABLE "grn_drafts" ADD CONSTRAINT "grn_drafts_version_check" CHECK ("version" >= 1);

-- A decided draft and its lines never change again, whatever the application does. (The API has
-- no delete; removing a whole draft row is left to maintenance, e.g. test cleanup.)
CREATE FUNCTION "grn_drafts_decided_immutable"() RETURNS trigger AS $$
BEGIN
  IF OLD."state" <> 'DRAFT' THEN
    RAISE EXCEPTION 'GRN draft % is decided and cannot change', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "grn_drafts_decided_immutable"
  BEFORE UPDATE ON "grn_drafts"
  FOR EACH ROW EXECUTE FUNCTION "grn_drafts_decided_immutable"();

CREATE FUNCTION "grn_draft_lines_open_draft_only"() RETURNS trigger AS $$
DECLARE
  draft_state "grn_draft_state";
BEGIN
  SELECT "state" INTO draft_state FROM "grn_drafts"
    WHERE "id" = CASE WHEN TG_OP = 'DELETE' THEN OLD."draft_id" ELSE NEW."draft_id" END;
  -- No draft row: its lines are going with it (ON DELETE CASCADE).
  IF FOUND AND draft_state <> 'DRAFT' THEN
    RAISE EXCEPTION 'The lines of a decided GRN draft cannot change'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "grn_draft_lines_open_draft_only"
  BEFORE INSERT OR UPDATE OR DELETE ON "grn_draft_lines"
  FOR EACH ROW EXECUTE FUNCTION "grn_draft_lines_open_draft_only"();
