-- CreateEnum
CREATE TYPE "consolidation_status" AS ENUM ('OPEN', 'CLOSED', 'LOADED', 'DEPARTED', 'ARRIVED', 'DECONSOLIDATED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "consolidation_basis" AS ENUM ('CBM', 'WEIGHT');

-- AlterEnum
ALTER TYPE "journal_source" ADD VALUE 'CONSOLIDATION_ALLOCATION';

-- AlterEnum
ALTER TYPE "supplier_bill_line_kind" ADD VALUE 'CONSOLIDATION';

-- AlterTable
ALTER TABLE "journal_lines" ADD COLUMN     "consolidation_id" UUID;

-- AlterTable
ALTER TABLE "supplier_bill_lines" ADD COLUMN     "allocation_entry_id" UUID,
ADD COLUMN     "consolidation_id" UUID;

-- CreateTable
CREATE TABLE "consolidations" (
    "id" UUID NOT NULL,
    "number" VARCHAR(30) NOT NULL,
    "branch_id" UUID NOT NULL,
    "origin_location_id" UUID NOT NULL,
    "destination_location_id" UUID NOT NULL,
    "container_type_code" VARCHAR(10) NOT NULL,
    "container_number" VARCHAR(11),
    "seal_number" VARCHAR(30),
    "carrier_name" VARCHAR(200),
    "vessel_name" VARCHAR(200),
    "voyage_number" VARCHAR(50),
    "master_bl_number" VARCHAR(50),
    "etd" DATE,
    "eta" DATE,
    "basis" "consolidation_basis" NOT NULL DEFAULT 'CBM',
    "status" "consolidation_status" NOT NULL DEFAULT 'OPEN',
    "closed_at" TIMESTAMPTZ(3),
    "loaded_at" TIMESTAMPTZ(3),
    "departed_at" TIMESTAMPTZ(3),
    "arrived_at" TIMESTAMPTZ(3),
    "deconsolidated_at" TIMESTAMPTZ(3),
    "cancelled_at" TIMESTAMPTZ(3),
    "cancel_reason" TEXT,
    "notes" TEXT,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "consolidations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consolidation_shipments" (
    "consolidation_id" UUID NOT NULL,
    "shipment_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "basis_value" DECIMAL(18,4),
    "added_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "consolidation_shipments_pkey" PRIMARY KEY ("consolidation_id","shipment_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "consolidations_number_key" ON "consolidations"("number");

-- CreateIndex
CREATE INDEX "consolidations_branch_id_status_idx" ON "consolidations"("branch_id", "status");

-- CreateIndex
CREATE INDEX "consolidation_shipments_shipment_id_idx" ON "consolidation_shipments"("shipment_id");

-- CreateIndex
CREATE INDEX "consolidation_shipments_branch_id_idx" ON "consolidation_shipments"("branch_id");

-- CreateIndex
CREATE INDEX "journal_lines_consolidation_id_idx" ON "journal_lines"("consolidation_id");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_bill_lines_allocation_entry_id_key" ON "supplier_bill_lines"("allocation_entry_id");

-- CreateIndex
CREATE INDEX "supplier_bill_lines_consolidation_id_idx" ON "supplier_bill_lines"("consolidation_id");

-- AddForeignKey
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_consolidation_id_fkey" FOREIGN KEY ("consolidation_id") REFERENCES "consolidations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consolidations" ADD CONSTRAINT "consolidations_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consolidations" ADD CONSTRAINT "consolidations_origin_location_id_fkey" FOREIGN KEY ("origin_location_id") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consolidations" ADD CONSTRAINT "consolidations_destination_location_id_fkey" FOREIGN KEY ("destination_location_id") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consolidations" ADD CONSTRAINT "consolidations_container_type_code_fkey" FOREIGN KEY ("container_type_code") REFERENCES "container_types"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consolidations" ADD CONSTRAINT "consolidations_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consolidation_shipments" ADD CONSTRAINT "consolidation_shipments_consolidation_id_fkey" FOREIGN KEY ("consolidation_id") REFERENCES "consolidations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consolidation_shipments" ADD CONSTRAINT "consolidation_shipments_shipment_id_fkey" FOREIGN KEY ("shipment_id") REFERENCES "shipments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consolidation_shipments" ADD CONSTRAINT "consolidation_shipments_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_bill_lines" ADD CONSTRAINT "supplier_bill_lines_consolidation_id_fkey" FOREIGN KEY ("consolidation_id") REFERENCES "consolidations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_bill_lines" ADD CONSTRAINT "supplier_bill_lines_allocation_entry_id_fkey" FOREIGN KEY ("allocation_entry_id") REFERENCES "journal_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Hand-written (raw SQL; Prisma does not model CHECK constraints). The services check the same.

-- Bill lines: each kind carries exactly its own references. A container cost names the container
-- and its charge type; only it is ever shared out by an allocation entry (rule 13). The new kind
-- is compared as text: an enum value added in this migration cannot be used as one until it
-- commits.
ALTER TABLE "supplier_bill_lines" DROP CONSTRAINT "supplier_bill_lines_kind_check";
ALTER TABLE "supplier_bill_lines" ADD CONSTRAINT "supplier_bill_lines_kind_check" CHECK (
    ("kind"::text = 'SHIPMENT_COST' AND "charge_type_code" IS NOT NULL AND "shipment_id" IS NOT NULL
        AND "trip_id" IS NULL AND "expense_category_code" IS NULL AND "consolidation_id" IS NULL)
    OR ("kind"::text = 'TRIP' AND "trip_id" IS NOT NULL AND "charge_type_code" IS NULL
        AND "shipment_id" IS NULL AND "expense_category_code" IS NULL AND "consolidation_id" IS NULL)
    OR ("kind"::text = 'EXPENSE' AND "expense_category_code" IS NOT NULL AND "charge_type_code" IS NULL
        AND "shipment_id" IS NULL AND "trip_id" IS NULL AND "consolidation_id" IS NULL)
    OR ("kind"::text = 'CONSOLIDATION' AND "consolidation_id" IS NOT NULL
        AND "charge_type_code" IS NOT NULL AND "shipment_id" IS NULL AND "trip_id" IS NULL
        AND "expense_category_code" IS NULL));
ALTER TABLE "supplier_bill_lines" ADD CONSTRAINT "supplier_bill_lines_allocation_check" CHECK (
    "allocation_entry_id" IS NULL OR "consolidation_id" IS NOT NULL);

-- Containers: an ISO 6346 number; a container past OPEN (and not cancelled) has its number and
-- the time it was closed; a cancelled one has its reason.
ALTER TABLE "consolidations" ADD CONSTRAINT "consolidations_container_number_check" CHECK (
    "container_number" IS NULL OR "container_number" ~ '^[A-Z]{4}[0-9]{7}$');
ALTER TABLE "consolidations" ADD CONSTRAINT "consolidations_closed_check" CHECK (
    "status" IN ('OPEN', 'CANCELLED') OR ("container_number" IS NOT NULL AND "closed_at" IS NOT NULL));
ALTER TABLE "consolidations" ADD CONSTRAINT "consolidations_cancel_check" CHECK (
    ("status" = 'CANCELLED') = ("cancelled_at" IS NOT NULL AND "cancel_reason" IS NOT NULL));
ALTER TABLE "consolidations" ADD CONSTRAINT "consolidations_dates_check" CHECK (
    "etd" IS NULL OR "eta" IS NULL OR "eta" >= "etd");
ALTER TABLE "consolidation_shipments" ADD CONSTRAINT "consolidation_shipments_basis_check" CHECK (
    "basis_value" IS NULL OR "basis_value" > 0);
