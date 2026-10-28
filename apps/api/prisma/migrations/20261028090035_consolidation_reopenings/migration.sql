-- CreateTable
CREATE TABLE "consolidation_reopenings" (
    "id" UUID NOT NULL,
    "consolidation_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "request_id" UUID NOT NULL,
    "request_hash" CHAR(64) NOT NULL,
    "closed_at" TIMESTAMPTZ(3) NOT NULL,
    "basis" JSONB NOT NULL,
    "shipment_ids" UUID[],
    "reason" VARCHAR(500) NOT NULL,
    "reopened_by_id" UUID NOT NULL,
    "reopened_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "consolidation_reopenings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "consolidation_reopenings_branch_id_idx" ON "consolidation_reopenings"("branch_id");

-- CreateIndex
CREATE UNIQUE INDEX "consolidation_reopenings_consolidation_id_revision_key" ON "consolidation_reopenings"("consolidation_id", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "consolidation_reopenings_consolidation_id_request_id_key" ON "consolidation_reopenings"("consolidation_id", "request_id");

-- AddForeignKey
ALTER TABLE "consolidation_reopenings" ADD CONSTRAINT "consolidation_reopenings_consolidation_id_fkey" FOREIGN KEY ("consolidation_id") REFERENCES "consolidations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consolidation_reopenings" ADD CONSTRAINT "consolidation_reopenings_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consolidation_reopenings" ADD CONSTRAINT "consolidation_reopenings_reopened_by_id_fkey" FOREIGN KEY ("reopened_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------------------------
-- Raw SQL, reviewed with the migration (docs/plans/05-correction-contracts.md, sections 0 and 5).
-- A reopening is insert-only: the close it took back and the basis frozen then stay as recorded.
-- ---------------------------------------------------------------------------------------------

ALTER TABLE "consolidation_reopenings" ADD CONSTRAINT "consolidation_reopenings_reason_check"
    CHECK (length(btrim("reason")) BETWEEN 3 AND 500);

ALTER TABLE "consolidation_reopenings" ADD CONSTRAINT "consolidation_reopenings_revision_check"
    CHECK ("revision" >= 1);

ALTER TABLE "consolidation_reopenings" ADD CONSTRAINT "consolidation_reopenings_request_hash_check"
    CHECK ("request_hash" ~ '^[0-9a-f]{64}$');

CREATE FUNCTION "consolidation_reopenings_insert_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'Container reopenings cannot be changed or deleted';
END;
$$;

CREATE TRIGGER "consolidation_reopenings_insert_only"
    BEFORE UPDATE OR DELETE ON "consolidation_reopenings"
    FOR EACH ROW EXECUTE FUNCTION "consolidation_reopenings_insert_only"();

CREATE TRIGGER "consolidation_reopenings_no_truncate"
    BEFORE TRUNCATE ON "consolidation_reopenings"
    FOR EACH STATEMENT EXECUTE FUNCTION "consolidation_reopenings_insert_only"();
