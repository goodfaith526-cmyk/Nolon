-- CreateEnum
CREATE TYPE "pallet_status" AS ENUM ('OPEN', 'CLOSED', 'UNPACKED', 'CANCELLED');

-- CreateTable
CREATE TABLE "pallets" (
    "id" UUID NOT NULL,
    "number" VARCHAR(30) NOT NULL,
    "branch_id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "status" "pallet_status" NOT NULL DEFAULT 'OPEN',
    "consolidation_id" UUID,
    "trip_id" UUID,
    "notes" VARCHAR(500),
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_by_id" UUID,
    "closed_at" TIMESTAMPTZ(3),
    "carried_at" TIMESTAMPTZ(3),
    "unpacked_by_id" UUID,
    "unpacked_at" TIMESTAMPTZ(3),
    "cancelled_by_id" UUID,
    "cancelled_at" TIMESTAMPTZ(3),
    "cancel_reason" VARCHAR(500),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pallets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pallet_shipments" (
    "pallet_id" UUID NOT NULL,
    "shipment_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "active_shipment_id" UUID,
    "added_by_id" UUID NOT NULL,
    "added_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pallet_shipments_pkey" PRIMARY KEY ("pallet_id","shipment_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "pallets_number_key" ON "pallets"("number");

-- CreateIndex
CREATE INDEX "pallets_branch_id_status_idx" ON "pallets"("branch_id", "status");

-- CreateIndex
CREATE INDEX "pallets_consolidation_id_idx" ON "pallets"("consolidation_id");

-- CreateIndex
CREATE INDEX "pallets_trip_id_idx" ON "pallets"("trip_id");

-- CreateIndex
CREATE UNIQUE INDEX "pallet_shipments_active_shipment_id_key" ON "pallet_shipments"("active_shipment_id");

-- CreateIndex
CREATE INDEX "pallet_shipments_shipment_id_idx" ON "pallet_shipments"("shipment_id");

-- CreateIndex
CREATE INDEX "pallet_shipments_branch_id_idx" ON "pallet_shipments"("branch_id");

-- AddForeignKey
ALTER TABLE "pallets" ADD CONSTRAINT "pallets_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pallets" ADD CONSTRAINT "pallets_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pallets" ADD CONSTRAINT "pallets_consolidation_id_fkey" FOREIGN KEY ("consolidation_id") REFERENCES "consolidations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pallets" ADD CONSTRAINT "pallets_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "trips"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pallets" ADD CONSTRAINT "pallets_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pallets" ADD CONSTRAINT "pallets_closed_by_id_fkey" FOREIGN KEY ("closed_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pallets" ADD CONSTRAINT "pallets_unpacked_by_id_fkey" FOREIGN KEY ("unpacked_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pallets" ADD CONSTRAINT "pallets_cancelled_by_id_fkey" FOREIGN KEY ("cancelled_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pallet_shipments" ADD CONSTRAINT "pallet_shipments_pallet_id_fkey" FOREIGN KEY ("pallet_id") REFERENCES "pallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pallet_shipments" ADD CONSTRAINT "pallet_shipments_shipment_id_fkey" FOREIGN KEY ("shipment_id") REFERENCES "shipments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pallet_shipments" ADD CONSTRAINT "pallet_shipments_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pallet_shipments" ADD CONSTRAINT "pallet_shipments_added_by_id_fkey" FOREIGN KEY ("added_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A pallet is carried by a container or a trip, never both.
ALTER TABLE "pallets" ADD CONSTRAINT "pallets_one_carrier_check"
    CHECK ("consolidation_id" IS NULL OR "trip_id" IS NULL);

-- The live link names its own shipment, never another.
ALTER TABLE "pallet_shipments" ADD CONSTRAINT "pallet_shipments_active_is_own_check"
    CHECK ("active_shipment_id" IS NULL OR "active_shipment_id" = "shipment_id");
