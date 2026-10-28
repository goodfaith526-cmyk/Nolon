-- CreateTable
CREATE TABLE "pod_cancellations" (
    "pod_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "cancelled_by_id" UUID NOT NULL,
    "cancelled_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pod_cancellations_pkey" PRIMARY KEY ("pod_id")
);

-- CreateIndex
CREATE INDEX "pod_cancellations_branch_id_idx" ON "pod_cancellations"("branch_id");

-- AddForeignKey
ALTER TABLE "pod_cancellations" ADD CONSTRAINT "pod_cancellations_pod_id_fkey" FOREIGN KEY ("pod_id") REFERENCES "proofs_of_delivery"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pod_cancellations" ADD CONSTRAINT "pod_cancellations_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pod_cancellations" ADD CONSTRAINT "pod_cancellations_cancelled_by_id_fkey" FOREIGN KEY ("cancelled_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------------------------
-- Raw SQL, reviewed with the migration (docs/plans/05-correction-contracts.md, section 2).
-- A cancellation is insert-only: the POD and its cancel stay as they were recorded.
-- ---------------------------------------------------------------------------------------------

ALTER TABLE "pod_cancellations" ADD CONSTRAINT "pod_cancellations_reason_check"
    CHECK (length(btrim("reason")) BETWEEN 3 AND 500);

CREATE FUNCTION "pod_cancellations_insert_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'Proof of delivery cancellations cannot be changed or deleted';
END;
$$;

CREATE TRIGGER "pod_cancellations_insert_only"
    BEFORE UPDATE OR DELETE ON "pod_cancellations"
    FOR EACH ROW EXECUTE FUNCTION "pod_cancellations_insert_only"();

CREATE TRIGGER "pod_cancellations_no_truncate"
    BEFORE TRUNCATE ON "pod_cancellations"
    FOR EACH STATEMENT EXECUTE FUNCTION "pod_cancellations_insert_only"();
