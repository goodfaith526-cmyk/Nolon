-- CreateEnum
CREATE TYPE "entry_draft_state" AS ENUM ('DRAFT', 'APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "quotation_drafts" (
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
    "origin_location_id" UUID NOT NULL,
    "destination_location_id" UUID NOT NULL,
    "mode" "shipping_mode" NOT NULL,
    "load_type" "load_type",
    "cargo_type" "cargo_type" NOT NULL,
    "cargo_description" VARCHAR(2000),
    "currency" CHAR(3) NOT NULL,
    "valid_until" DATE NOT NULL,
    "terms" VARCHAR(4000),
    "decided_by_id" UUID,
    "decided_at" TIMESTAMPTZ(3),
    "reject_reason" VARCHAR(500),
    "quotation_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "quotation_drafts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quotation_draft_lines" (
    "draft_id" UUID NOT NULL,
    "line_no" INTEGER NOT NULL,
    "rate_card_id" UUID,
    "charge_type_code" VARCHAR(20),
    "description" VARCHAR(500),
    "unit" "rate_unit",
    "quantity" DECIMAL(18,4) NOT NULL,
    "unit_price" DECIMAL(18,4),
    "discount" DECIMAL(18,4),

    CONSTRAINT "quotation_draft_lines_pkey" PRIMARY KEY ("draft_id","line_no")
);

-- CreateTable
CREATE TABLE "booking_drafts" (
    "id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "source_quotation_id" UUID,
    "state" "entry_draft_state" NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 1,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "agent_client_id" UUID NOT NULL,
    "created_by_id" UUID NOT NULL,
    "idempotency_key" VARCHAR(100) NOT NULL,
    "payload_hash" CHAR(64) NOT NULL,
    "origin_location_id" UUID,
    "destination_location_id" UUID,
    "mode" "shipping_mode",
    "load_type" "load_type",
    "cargo_type" "cargo_type",
    "cargo_description" VARCHAR(2000),
    "services" "booking_service"[],
    "shipper_id" UUID,
    "consignee_id" UUID,
    "notify_party_id" UUID,
    "requested_departure" DATE,
    "special_instructions" VARCHAR(2000),
    "decided_by_id" UUID,
    "decided_at" TIMESTAMPTZ(3),
    "reject_reason" VARCHAR(500),
    "booking_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "booking_drafts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "booking_draft_items" (
    "draft_id" UUID NOT NULL,
    "line_no" INTEGER NOT NULL,
    "cargo_type" "cargo_type" NOT NULL,
    "container_type_code" VARCHAR(10),
    "description" VARCHAR(500),
    "quantity" INTEGER NOT NULL,
    "length_cm" DECIMAL(10,2),
    "width_cm" DECIMAL(10,2),
    "height_cm" DECIMAL(10,2),
    "weight_kg" DECIMAL(12,3),
    "volume_cbm" DECIMAL(12,4),

    CONSTRAINT "booking_draft_items_pkey" PRIMARY KEY ("draft_id","line_no")
);

-- CreateIndex
CREATE UNIQUE INDEX "quotation_drafts_quotation_id_key" ON "quotation_drafts"("quotation_id");

-- CreateIndex
CREATE INDEX "quotation_drafts_branch_id_state_idx" ON "quotation_drafts"("branch_id", "state");

-- CreateIndex
CREATE UNIQUE INDEX "quotation_drafts_agent_client_id_created_by_id_idempotency__key" ON "quotation_drafts"("agent_client_id", "created_by_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "booking_drafts_booking_id_key" ON "booking_drafts"("booking_id");

-- CreateIndex
CREATE INDEX "booking_drafts_branch_id_state_idx" ON "booking_drafts"("branch_id", "state");

-- CreateIndex
CREATE INDEX "booking_drafts_source_quotation_id_idx" ON "booking_drafts"("source_quotation_id");

-- CreateIndex
CREATE UNIQUE INDEX "booking_drafts_agent_client_id_created_by_id_idempotency_ke_key" ON "booking_drafts"("agent_client_id", "created_by_id", "idempotency_key");

-- AddForeignKey
ALTER TABLE "quotation_drafts" ADD CONSTRAINT "quotation_drafts_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotation_drafts" ADD CONSTRAINT "quotation_drafts_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotation_drafts" ADD CONSTRAINT "quotation_drafts_agent_client_id_fkey" FOREIGN KEY ("agent_client_id") REFERENCES "agent_clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotation_drafts" ADD CONSTRAINT "quotation_drafts_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotation_drafts" ADD CONSTRAINT "quotation_drafts_decided_by_id_fkey" FOREIGN KEY ("decided_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotation_drafts" ADD CONSTRAINT "quotation_drafts_quotation_id_fkey" FOREIGN KEY ("quotation_id") REFERENCES "quotations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotation_draft_lines" ADD CONSTRAINT "quotation_draft_lines_draft_id_fkey" FOREIGN KEY ("draft_id") REFERENCES "quotation_drafts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking_drafts" ADD CONSTRAINT "booking_drafts_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking_drafts" ADD CONSTRAINT "booking_drafts_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking_drafts" ADD CONSTRAINT "booking_drafts_source_quotation_id_fkey" FOREIGN KEY ("source_quotation_id") REFERENCES "quotations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking_drafts" ADD CONSTRAINT "booking_drafts_agent_client_id_fkey" FOREIGN KEY ("agent_client_id") REFERENCES "agent_clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking_drafts" ADD CONSTRAINT "booking_drafts_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking_drafts" ADD CONSTRAINT "booking_drafts_decided_by_id_fkey" FOREIGN KEY ("decided_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking_drafts" ADD CONSTRAINT "booking_drafts_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking_draft_items" ADD CONSTRAINT "booking_draft_items_draft_id_fkey" FOREIGN KEY ("draft_id") REFERENCES "booking_drafts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A draft's decision fields agree with its state: only an approval carries its result, only a
-- rejection a reason, and an open draft carries neither.
ALTER TABLE "quotation_drafts" ADD CONSTRAINT "quotation_drafts_decision_check" CHECK (
  ("state" = 'DRAFT' AND "decided_at" IS NULL AND "decided_by_id" IS NULL
     AND "quotation_id" IS NULL AND "reject_reason" IS NULL)
  OR ("state" = 'APPROVED' AND "decided_at" IS NOT NULL AND "decided_by_id" IS NOT NULL
     AND "quotation_id" IS NOT NULL AND "reject_reason" IS NULL)
  OR ("state" = 'REJECTED' AND "decided_at" IS NOT NULL AND "decided_by_id" IS NOT NULL
     AND "quotation_id" IS NULL AND "reject_reason" IS NOT NULL)
);
ALTER TABLE "quotation_drafts" ADD CONSTRAINT "quotation_drafts_version_check" CHECK ("version" >= 1);

ALTER TABLE "booking_drafts" ADD CONSTRAINT "booking_drafts_decision_check" CHECK (
  ("state" = 'DRAFT' AND "decided_at" IS NULL AND "decided_by_id" IS NULL
     AND "booking_id" IS NULL AND "reject_reason" IS NULL)
  OR ("state" = 'APPROVED' AND "decided_at" IS NOT NULL AND "decided_by_id" IS NOT NULL
     AND "booking_id" IS NOT NULL AND "reject_reason" IS NULL)
  OR ("state" = 'REJECTED' AND "decided_at" IS NOT NULL AND "decided_by_id" IS NOT NULL
     AND "booking_id" IS NULL AND "reject_reason" IS NOT NULL)
);
ALTER TABLE "booking_drafts" ADD CONSTRAINT "booking_drafts_version_check" CHECK ("version" >= 1);

-- A booking draft is either from a quotation (route and cargo come from it) or carries its own.
ALTER TABLE "booking_drafts" ADD CONSTRAINT "booking_drafts_source_check" CHECK (
  ("source_quotation_id" IS NOT NULL AND "origin_location_id" IS NULL
     AND "destination_location_id" IS NULL AND "mode" IS NULL AND "load_type" IS NULL
     AND "cargo_type" IS NULL AND "cargo_description" IS NULL)
  OR ("source_quotation_id" IS NULL AND "origin_location_id" IS NOT NULL
     AND "destination_location_id" IS NOT NULL AND "mode" IS NOT NULL AND "cargo_type" IS NOT NULL)
);

-- Amounts and quantities are never negative.
ALTER TABLE "quotation_draft_lines" ADD CONSTRAINT "quotation_draft_lines_amounts_check" CHECK (
  "quantity" > 0 AND ("unit_price" IS NULL OR "unit_price" >= 0)
  AND ("discount" IS NULL OR "discount" >= 0)
);
ALTER TABLE "booking_draft_items" ADD CONSTRAINT "booking_draft_items_amounts_check" CHECK (
  "quantity" >= 1 AND ("weight_kg" IS NULL OR "weight_kg" >= 0)
  AND ("volume_cbm" IS NULL OR "volume_cbm" >= 0)
);

-- Shared by the draft tables of this migration: a decided draft never changes again, whatever
-- the application does. (The API has no delete; removing a whole draft row is left to
-- maintenance, e.g. test cleanup.)
CREATE FUNCTION "entry_draft_decided_immutable"() RETURNS trigger AS $$
BEGIN
  IF OLD."state" <> 'DRAFT' THEN
    RAISE EXCEPTION '% row % is decided and cannot change', TG_TABLE_NAME, OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- The lines and items of a decided draft never change, nor move to another draft.
CREATE FUNCTION "quotation_draft_lines_open_draft_only"() RETURNS trigger AS $$
DECLARE
  draft_state "entry_draft_state";
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."draft_id" <> OLD."draft_id" THEN
    RAISE EXCEPTION 'A quotation draft line cannot move to another draft'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT "state" INTO draft_state FROM "quotation_drafts"
    WHERE "id" = CASE WHEN TG_OP = 'DELETE' THEN OLD."draft_id" ELSE NEW."draft_id" END;
  -- No draft row: its quotation draft lines are going with it (ON DELETE CASCADE).
  IF FOUND AND draft_state <> 'DRAFT' THEN
    RAISE EXCEPTION 'The quotation draft lines of a decided draft cannot change'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION "booking_draft_items_open_draft_only"() RETURNS trigger AS $$
DECLARE
  draft_state "entry_draft_state";
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."draft_id" <> OLD."draft_id" THEN
    RAISE EXCEPTION 'A booking draft item cannot move to another draft'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT "state" INTO draft_state FROM "booking_drafts"
    WHERE "id" = CASE WHEN TG_OP = 'DELETE' THEN OLD."draft_id" ELSE NEW."draft_id" END;
  -- No draft row: its booking draft items are going with it (ON DELETE CASCADE).
  IF FOUND AND draft_state <> 'DRAFT' THEN
    RAISE EXCEPTION 'The booking draft items of a decided draft cannot change'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "quotation_drafts_decided_immutable"
  BEFORE UPDATE ON "quotation_drafts"
  FOR EACH ROW EXECUTE FUNCTION "entry_draft_decided_immutable"();
CREATE TRIGGER "quotation_draft_lines_open_draft_only"
  BEFORE INSERT OR UPDATE OR DELETE ON "quotation_draft_lines"
  FOR EACH ROW EXECUTE FUNCTION "quotation_draft_lines_open_draft_only"();

CREATE TRIGGER "booking_drafts_decided_immutable"
  BEFORE UPDATE ON "booking_drafts"
  FOR EACH ROW EXECUTE FUNCTION "entry_draft_decided_immutable"();
CREATE TRIGGER "booking_draft_items_open_draft_only"
  BEFORE INSERT OR UPDATE OR DELETE ON "booking_draft_items"
  FOR EACH ROW EXECUTE FUNCTION "booking_draft_items_open_draft_only"();
