-- CreateTable
CREATE TABLE "trip_departure_undos" (
    "id" UUID NOT NULL,
    "trip_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "request_id" UUID NOT NULL,
    "request_hash" CHAR(64) NOT NULL,
    "departed_at" TIMESTAMPTZ(3) NOT NULL,
    "shipment_ids" UUID[],
    "reason" VARCHAR(500) NOT NULL,
    "undone_by_id" UUID NOT NULL,
    "undone_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trip_departure_undos_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "trip_departure_undos_branch_id_idx" ON "trip_departure_undos"("branch_id");

-- CreateIndex
CREATE UNIQUE INDEX "trip_departure_undos_trip_id_revision_key" ON "trip_departure_undos"("trip_id", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "trip_departure_undos_trip_id_request_id_key" ON "trip_departure_undos"("trip_id", "request_id");

-- AddForeignKey
ALTER TABLE "trip_departure_undos" ADD CONSTRAINT "trip_departure_undos_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "trips"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip_departure_undos" ADD CONSTRAINT "trip_departure_undos_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip_departure_undos" ADD CONSTRAINT "trip_departure_undos_undone_by_id_fkey" FOREIGN KEY ("undone_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------------------------
-- Raw SQL, reviewed with the migration (docs/plans/05-correction-contracts.md, sections 0 and 4).
-- An undone departure is insert-only: what was taken back stays as it was recorded.
-- ---------------------------------------------------------------------------------------------

ALTER TABLE "trip_departure_undos" ADD CONSTRAINT "trip_departure_undos_reason_check"
    CHECK (length(btrim("reason")) BETWEEN 3 AND 500);

ALTER TABLE "trip_departure_undos" ADD CONSTRAINT "trip_departure_undos_revision_check"
    CHECK ("revision" >= 1);

ALTER TABLE "trip_departure_undos" ADD CONSTRAINT "trip_departure_undos_request_hash_check"
    CHECK ("request_hash" ~ '^[0-9a-f]{64}$');

CREATE FUNCTION "trip_departure_undos_insert_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'Undone trip departures cannot be changed or deleted';
END;
$$;

CREATE TRIGGER "trip_departure_undos_insert_only"
    BEFORE UPDATE OR DELETE ON "trip_departure_undos"
    FOR EACH ROW EXECUTE FUNCTION "trip_departure_undos_insert_only"();

CREATE TRIGGER "trip_departure_undos_no_truncate"
    BEFORE TRUNCATE ON "trip_departure_undos"
    FOR EACH STATEMENT EXECUTE FUNCTION "trip_departure_undos_insert_only"();
