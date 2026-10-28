-- CreateTable
CREATE TABLE "warehouse_movement_cancellations" (
    "movement_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "cancelled_by_id" UUID NOT NULL,
    "cancelled_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "warehouse_movement_cancellations_pkey" PRIMARY KEY ("movement_id")
);

-- CreateIndex
CREATE INDEX "warehouse_movement_cancellations_branch_id_idx" ON "warehouse_movement_cancellations"("branch_id");

-- AddForeignKey
ALTER TABLE "warehouse_movement_cancellations" ADD CONSTRAINT "warehouse_movement_cancellations_movement_id_fkey" FOREIGN KEY ("movement_id") REFERENCES "warehouse_movements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse_movement_cancellations" ADD CONSTRAINT "warehouse_movement_cancellations_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse_movement_cancellations" ADD CONSTRAINT "warehouse_movement_cancellations_cancelled_by_id_fkey" FOREIGN KEY ("cancelled_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------------------------
-- Raw SQL, reviewed with the migration (docs/plans/05-correction-contracts.md, section 1).
-- A cancellation is insert-only, like the renumbering log: the movement and its cancel stay as
-- they were recorded.
-- ---------------------------------------------------------------------------------------------

ALTER TABLE "warehouse_movement_cancellations" ADD CONSTRAINT "warehouse_movement_cancellations_reason_check"
    CHECK (length(btrim("reason")) BETWEEN 3 AND 500);

CREATE FUNCTION "warehouse_movement_cancellations_insert_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'Warehouse movement cancellations cannot be changed or deleted';
END;
$$;

CREATE TRIGGER "warehouse_movement_cancellations_insert_only"
    BEFORE UPDATE OR DELETE ON "warehouse_movement_cancellations"
    FOR EACH ROW EXECUTE FUNCTION "warehouse_movement_cancellations_insert_only"();

CREATE TRIGGER "warehouse_movement_cancellations_no_truncate"
    BEFORE TRUNCATE ON "warehouse_movement_cancellations"
    FOR EACH STATEMENT EXECUTE FUNCTION "warehouse_movement_cancellations_insert_only"();
