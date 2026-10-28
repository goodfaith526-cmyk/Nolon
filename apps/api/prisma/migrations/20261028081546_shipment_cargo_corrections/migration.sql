-- CreateTable
CREATE TABLE "shipment_cargo_corrections" (
    "id" UUID NOT NULL,
    "shipment_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "request_id" UUID NOT NULL,
    "request_hash" CHAR(64) NOT NULL,
    "items_before" JSONB NOT NULL,
    "items_after" JSONB NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "container_id" UUID,
    "corrected_by_id" UUID NOT NULL,
    "corrected_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shipment_cargo_corrections_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "shipment_cargo_corrections_branch_id_idx" ON "shipment_cargo_corrections"("branch_id");

-- CreateIndex
CREATE UNIQUE INDEX "shipment_cargo_corrections_shipment_id_revision_key" ON "shipment_cargo_corrections"("shipment_id", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "shipment_cargo_corrections_shipment_id_request_id_key" ON "shipment_cargo_corrections"("shipment_id", "request_id");

-- AddForeignKey
ALTER TABLE "shipment_cargo_corrections" ADD CONSTRAINT "shipment_cargo_corrections_shipment_id_fkey" FOREIGN KEY ("shipment_id") REFERENCES "shipments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_cargo_corrections" ADD CONSTRAINT "shipment_cargo_corrections_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_cargo_corrections" ADD CONSTRAINT "shipment_cargo_corrections_container_id_fkey" FOREIGN KEY ("container_id") REFERENCES "consolidations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_cargo_corrections" ADD CONSTRAINT "shipment_cargo_corrections_corrected_by_id_fkey" FOREIGN KEY ("corrected_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------------------------
-- Raw SQL, reviewed with the migration (docs/plans/05-correction-contracts.md, sections 0 and 3).
-- A cargo correction is insert-only: the lines before and after stay as they were recorded.
-- ---------------------------------------------------------------------------------------------

ALTER TABLE "shipment_cargo_corrections" ADD CONSTRAINT "shipment_cargo_corrections_reason_check"
    CHECK (length(btrim("reason")) BETWEEN 3 AND 500);

ALTER TABLE "shipment_cargo_corrections" ADD CONSTRAINT "shipment_cargo_corrections_revision_check"
    CHECK ("revision" >= 1);

ALTER TABLE "shipment_cargo_corrections" ADD CONSTRAINT "shipment_cargo_corrections_request_hash_check"
    CHECK ("request_hash" ~ '^[0-9a-f]{64}$');

CREATE FUNCTION "shipment_cargo_corrections_insert_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'Cargo corrections cannot be changed or deleted';
END;
$$;

CREATE TRIGGER "shipment_cargo_corrections_insert_only"
    BEFORE UPDATE OR DELETE ON "shipment_cargo_corrections"
    FOR EACH ROW EXECUTE FUNCTION "shipment_cargo_corrections_insert_only"();

CREATE TRIGGER "shipment_cargo_corrections_no_truncate"
    BEFORE TRUNCATE ON "shipment_cargo_corrections"
    FOR EACH STATEMENT EXECUTE FUNCTION "shipment_cargo_corrections_insert_only"();
