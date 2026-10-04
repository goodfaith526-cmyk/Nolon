-- CreateEnum
CREATE TYPE "warehouse_movement_kind" AS ENUM ('RECEIPT', 'RELEASE');

-- CreateEnum
CREATE TYPE "goods_condition" AS ENUM ('GOOD', 'DAMAGED');

-- CreateEnum
CREATE TYPE "customs_status" AS ENUM ('PENDING', 'SUBMITTED', 'INSPECTION', 'HELD', 'CLEARED');

-- CreateTable
CREATE TABLE "warehouses" (
    "id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "code" VARCHAR(20) NOT NULL,
    "name_en" VARCHAR(200) NOT NULL,
    "name_ar" VARCHAR(200) NOT NULL,
    "address" VARCHAR(500),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "warehouses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "storage_locations" (
    "id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "code" VARCHAR(20) NOT NULL,
    "name" VARCHAR(200),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "storage_locations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouse_movements" (
    "id" UUID NOT NULL,
    "number" VARCHAR(30) NOT NULL,
    "kind" "warehouse_movement_kind" NOT NULL,
    "branch_id" UUID NOT NULL,
    "shipment_id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "storage_location_id" UUID,
    "packages" INTEGER NOT NULL,
    "weight_kg" DECIMAL(12,3),
    "condition" "goods_condition",
    "party_name" VARCHAR(200),
    "note" TEXT,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "status_applied" "shipment_status",
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "warehouse_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouse_movement_photos" (
    "movement_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,

    CONSTRAINT "warehouse_movement_photos_pkey" PRIMARY KEY ("movement_id","document_id")
);

-- CreateTable
CREATE TABLE "customs_clearances" (
    "id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "shipment_id" UUID NOT NULL,
    "status" "customs_status" NOT NULL DEFAULT 'PENDING',
    "declaration_number" VARCHAR(50),
    "broker_name" VARCHAR(200),
    "submitted_on" DATE,
    "cleared_on" DATE,
    "note" TEXT,
    "updated_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "customs_clearances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customs_fees" (
    "id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "shipment_id" UUID NOT NULL,
    "description" VARCHAR(200) NOT NULL,
    "amount" DECIMAL(18,4) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "note" TEXT,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customs_fees_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "warehouses_code_key" ON "warehouses"("code");

-- CreateIndex
CREATE INDEX "warehouses_branch_id_idx" ON "warehouses"("branch_id");

-- CreateIndex
CREATE INDEX "storage_locations_branch_id_idx" ON "storage_locations"("branch_id");

-- CreateIndex
CREATE UNIQUE INDEX "storage_locations_warehouse_id_code_key" ON "storage_locations"("warehouse_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_movements_number_key" ON "warehouse_movements"("number");

-- CreateIndex
CREATE INDEX "warehouse_movements_shipment_id_warehouse_id_idx" ON "warehouse_movements"("shipment_id", "warehouse_id");

-- CreateIndex
CREATE INDEX "warehouse_movements_warehouse_id_idx" ON "warehouse_movements"("warehouse_id");

-- CreateIndex
CREATE INDEX "warehouse_movements_branch_id_idx" ON "warehouse_movements"("branch_id");

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_movement_photos_document_id_key" ON "warehouse_movement_photos"("document_id");

-- CreateIndex
CREATE INDEX "warehouse_movement_photos_branch_id_idx" ON "warehouse_movement_photos"("branch_id");

-- CreateIndex
CREATE UNIQUE INDEX "customs_clearances_shipment_id_key" ON "customs_clearances"("shipment_id");

-- CreateIndex
CREATE INDEX "customs_clearances_branch_id_idx" ON "customs_clearances"("branch_id");

-- CreateIndex
CREATE INDEX "customs_fees_shipment_id_idx" ON "customs_fees"("shipment_id");

-- CreateIndex
CREATE INDEX "customs_fees_branch_id_idx" ON "customs_fees"("branch_id");

-- AddForeignKey
ALTER TABLE "warehouses" ADD CONSTRAINT "warehouses_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "storage_locations" ADD CONSTRAINT "storage_locations_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "storage_locations" ADD CONSTRAINT "storage_locations_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse_movements" ADD CONSTRAINT "warehouse_movements_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse_movements" ADD CONSTRAINT "warehouse_movements_shipment_id_fkey" FOREIGN KEY ("shipment_id") REFERENCES "shipments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse_movements" ADD CONSTRAINT "warehouse_movements_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse_movements" ADD CONSTRAINT "warehouse_movements_storage_location_id_fkey" FOREIGN KEY ("storage_location_id") REFERENCES "storage_locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse_movements" ADD CONSTRAINT "warehouse_movements_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse_movement_photos" ADD CONSTRAINT "warehouse_movement_photos_movement_id_fkey" FOREIGN KEY ("movement_id") REFERENCES "warehouse_movements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse_movement_photos" ADD CONSTRAINT "warehouse_movement_photos_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse_movement_photos" ADD CONSTRAINT "warehouse_movement_photos_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customs_clearances" ADD CONSTRAINT "customs_clearances_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customs_clearances" ADD CONSTRAINT "customs_clearances_shipment_id_fkey" FOREIGN KEY ("shipment_id") REFERENCES "shipments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customs_clearances" ADD CONSTRAINT "customs_clearances_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customs_fees" ADD CONSTRAINT "customs_fees_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customs_fees" ADD CONSTRAINT "customs_fees_shipment_id_fkey" FOREIGN KEY ("shipment_id") REFERENCES "shipments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customs_fees" ADD CONSTRAINT "customs_fees_currency_fkey" FOREIGN KEY ("currency") REFERENCES "currencies"("code") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "customs_fees" ADD CONSTRAINT "customs_fees_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Checks (raw SQL; Prisma does not model CHECK constraints).
ALTER TABLE "warehouses" ADD CONSTRAINT "warehouses_code_check" CHECK ("code" = upper(btrim("code")) AND "code" <> '');
ALTER TABLE "storage_locations" ADD CONSTRAINT "storage_locations_code_check" CHECK ("code" = upper(btrim("code")) AND "code" <> '');
-- Quantities: a movement moves at least one package; weights are never negative.
ALTER TABLE "warehouse_movements" ADD CONSTRAINT "warehouse_movements_packages_check" CHECK ("packages" > 0);
ALTER TABLE "warehouse_movements" ADD CONSTRAINT "warehouse_movements_weight_check" CHECK ("weight_kg" IS NULL OR "weight_kg" >= 0);
-- A receipt records the condition of the goods; only a receipt moves the shipment's status.
ALTER TABLE "warehouse_movements" ADD CONSTRAINT "warehouse_movements_condition_check" CHECK ("kind" <> 'RECEIPT' OR "condition" IS NOT NULL);
ALTER TABLE "warehouse_movements" ADD CONSTRAINT "warehouse_movements_status_check" CHECK (
    "status_applied" IS NULL
    OR ("kind" = 'RECEIPT' AND "status_applied" IN ('RECEIVED_ORIGIN_WAREHOUSE', 'RECEIVED_DESTINATION_WAREHOUSE'))
);
ALTER TABLE "customs_clearances" ADD CONSTRAINT "customs_clearances_dates_check" CHECK (
    "cleared_on" IS NULL OR "submitted_on" IS NULL OR "cleared_on" >= "submitted_on"
);
ALTER TABLE "customs_fees" ADD CONSTRAINT "customs_fees_amount_check" CHECK ("amount" > 0);
