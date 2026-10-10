-- CreateTable
CREATE TABLE "trip_drafts" (
    "id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "state" "entry_draft_state" NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 1,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "agent_client_id" UUID NOT NULL,
    "created_by_id" UUID NOT NULL,
    "idempotency_key" VARCHAR(100) NOT NULL,
    "payload_hash" CHAR(64) NOT NULL,
    "kind" "trip_kind" NOT NULL,
    "origin_location_id" UUID NOT NULL,
    "destination_location_id" UUID NOT NULL,
    "planned_departure" TIMESTAMPTZ(3),
    "planned_arrival" TIMESTAMPTZ(3),
    "vehicle_id" UUID,
    "driver_id" UUID,
    "carrier_id" UUID,
    "agreed_cost" DECIMAL(18,4),
    "currency" CHAR(3),
    "external_vehicle" VARCHAR(100),
    "external_driver" VARCHAR(200),
    "notes" VARCHAR(2000),
    "decided_by_id" UUID,
    "decided_at" TIMESTAMPTZ(3),
    "reject_reason" VARCHAR(500),
    "trip_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "trip_drafts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trip_draft_shipments" (
    "draft_id" UUID NOT NULL,
    "line_no" INTEGER NOT NULL,
    "shipment_id" UUID NOT NULL,

    CONSTRAINT "trip_draft_shipments_pkey" PRIMARY KEY ("draft_id","line_no")
);

-- CreateTable
CREATE TABLE "goods_release_drafts" (
    "id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "shipment_id" UUID NOT NULL,
    "state" "entry_draft_state" NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 1,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "agent_client_id" UUID NOT NULL,
    "created_by_id" UUID NOT NULL,
    "idempotency_key" VARCHAR(100) NOT NULL,
    "payload_hash" CHAR(64) NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "packages" INTEGER NOT NULL,
    "weight_kg" DECIMAL(12,3),
    "party_name" VARCHAR(200),
    "note" VARCHAR(1000),
    "decided_by_id" UUID,
    "decided_at" TIMESTAMPTZ(3),
    "reject_reason" VARCHAR(500),
    "movement_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "goods_release_drafts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "trip_drafts_trip_id_key" ON "trip_drafts"("trip_id");

-- CreateIndex
CREATE INDEX "trip_drafts_branch_id_state_idx" ON "trip_drafts"("branch_id", "state");

-- CreateIndex
CREATE UNIQUE INDEX "trip_drafts_agent_client_id_created_by_id_idempotency_key_key" ON "trip_drafts"("agent_client_id", "created_by_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "trip_draft_shipments_shipment_id_idx" ON "trip_draft_shipments"("shipment_id");

-- CreateIndex
CREATE UNIQUE INDEX "trip_draft_shipments_draft_id_shipment_id_key" ON "trip_draft_shipments"("draft_id", "shipment_id");

-- CreateIndex
CREATE UNIQUE INDEX "goods_release_drafts_movement_id_key" ON "goods_release_drafts"("movement_id");

-- CreateIndex
CREATE INDEX "goods_release_drafts_branch_id_state_idx" ON "goods_release_drafts"("branch_id", "state");

-- CreateIndex
CREATE INDEX "goods_release_drafts_shipment_id_idx" ON "goods_release_drafts"("shipment_id");

-- CreateIndex
CREATE UNIQUE INDEX "goods_release_drafts_agent_client_id_created_by_id_idempote_key" ON "goods_release_drafts"("agent_client_id", "created_by_id", "idempotency_key");

-- AddForeignKey
ALTER TABLE "trip_drafts" ADD CONSTRAINT "trip_drafts_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip_drafts" ADD CONSTRAINT "trip_drafts_agent_client_id_fkey" FOREIGN KEY ("agent_client_id") REFERENCES "agent_clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip_drafts" ADD CONSTRAINT "trip_drafts_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip_drafts" ADD CONSTRAINT "trip_drafts_decided_by_id_fkey" FOREIGN KEY ("decided_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip_drafts" ADD CONSTRAINT "trip_drafts_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "trips"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip_draft_shipments" ADD CONSTRAINT "trip_draft_shipments_draft_id_fkey" FOREIGN KEY ("draft_id") REFERENCES "trip_drafts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip_draft_shipments" ADD CONSTRAINT "trip_draft_shipments_shipment_id_fkey" FOREIGN KEY ("shipment_id") REFERENCES "shipments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_release_drafts" ADD CONSTRAINT "goods_release_drafts_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_release_drafts" ADD CONSTRAINT "goods_release_drafts_shipment_id_fkey" FOREIGN KEY ("shipment_id") REFERENCES "shipments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_release_drafts" ADD CONSTRAINT "goods_release_drafts_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_release_drafts" ADD CONSTRAINT "goods_release_drafts_agent_client_id_fkey" FOREIGN KEY ("agent_client_id") REFERENCES "agent_clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_release_drafts" ADD CONSTRAINT "goods_release_drafts_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_release_drafts" ADD CONSTRAINT "goods_release_drafts_decided_by_id_fkey" FOREIGN KEY ("decided_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_release_drafts" ADD CONSTRAINT "goods_release_drafts_movement_id_fkey" FOREIGN KEY ("movement_id") REFERENCES "warehouse_movements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A draft's decision fields agree with its state: only an approval carries its result, only a
-- rejection a reason, and an open draft carries neither.
ALTER TABLE "trip_drafts" ADD CONSTRAINT "trip_drafts_decision_check" CHECK (
  ("state" = 'DRAFT' AND "decided_at" IS NULL AND "decided_by_id" IS NULL
     AND "trip_id" IS NULL AND "reject_reason" IS NULL)
  OR ("state" = 'APPROVED' AND "decided_at" IS NOT NULL AND "decided_by_id" IS NOT NULL
     AND "trip_id" IS NOT NULL AND "reject_reason" IS NULL)
  OR ("state" = 'REJECTED' AND "decided_at" IS NOT NULL AND "decided_by_id" IS NOT NULL
     AND "trip_id" IS NULL AND "reject_reason" IS NOT NULL)
);
ALTER TABLE "trip_drafts" ADD CONSTRAINT "trip_drafts_version_check" CHECK ("version" >= 1);
ALTER TABLE "trip_drafts" ADD CONSTRAINT "trip_drafts_cost_check" CHECK (
  "agreed_cost" IS NULL OR "agreed_cost" >= 0
);

ALTER TABLE "goods_release_drafts" ADD CONSTRAINT "goods_release_drafts_decision_check" CHECK (
  ("state" = 'DRAFT' AND "decided_at" IS NULL AND "decided_by_id" IS NULL
     AND "movement_id" IS NULL AND "reject_reason" IS NULL)
  OR ("state" = 'APPROVED' AND "decided_at" IS NOT NULL AND "decided_by_id" IS NOT NULL
     AND "movement_id" IS NOT NULL AND "reject_reason" IS NULL)
  OR ("state" = 'REJECTED' AND "decided_at" IS NOT NULL AND "decided_by_id" IS NOT NULL
     AND "movement_id" IS NULL AND "reject_reason" IS NOT NULL)
);
ALTER TABLE "goods_release_drafts" ADD CONSTRAINT "goods_release_drafts_version_check" CHECK (
  "version" >= 1
);
ALTER TABLE "goods_release_drafts" ADD CONSTRAINT "goods_release_drafts_amounts_check" CHECK (
  "packages" >= 1 AND ("weight_kg" IS NULL OR "weight_kg" >= 0)
);

-- A decided draft never changes again, whatever the application does. (The API has no delete;
-- removing a whole draft row is left to maintenance, e.g. test cleanup.)
CREATE FUNCTION "trip_drafts_decided_immutable"() RETURNS trigger AS $$
BEGIN
  IF OLD."state" <> 'DRAFT' THEN
    RAISE EXCEPTION 'Trip draft % is decided and cannot change', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "trip_drafts_decided_immutable"
  BEFORE UPDATE ON "trip_drafts"
  FOR EACH ROW EXECUTE FUNCTION "trip_drafts_decided_immutable"();

CREATE FUNCTION "goods_release_drafts_decided_immutable"() RETURNS trigger AS $$
BEGIN
  IF OLD."state" <> 'DRAFT' THEN
    RAISE EXCEPTION 'Goods release draft % is decided and cannot change', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "goods_release_drafts_decided_immutable"
  BEFORE UPDATE ON "goods_release_drafts"
  FOR EACH ROW EXECUTE FUNCTION "goods_release_drafts_decided_immutable"();

-- The shipments of a decided trip draft never change, nor move to another draft.
CREATE FUNCTION "trip_draft_shipments_open_draft_only"() RETURNS trigger AS $$
DECLARE
  draft_state "entry_draft_state";
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."draft_id" <> OLD."draft_id" THEN
    RAISE EXCEPTION 'A trip draft shipment cannot move to another draft'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT "state" INTO draft_state FROM "trip_drafts"
    WHERE "id" = CASE WHEN TG_OP = 'DELETE' THEN OLD."draft_id" ELSE NEW."draft_id" END;
  -- No draft row: its shipments are going with it (ON DELETE CASCADE).
  IF FOUND AND draft_state <> 'DRAFT' THEN
    RAISE EXCEPTION 'The shipments of a decided trip draft cannot change'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "trip_draft_shipments_open_draft_only"
  BEFORE INSERT OR UPDATE OR DELETE ON "trip_draft_shipments"
  FOR EACH ROW EXECUTE FUNCTION "trip_draft_shipments_open_draft_only"();
