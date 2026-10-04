-- CreateEnum
CREATE TYPE "trip_kind" AS ENUM ('OWN', 'EXTERNAL');

-- CreateEnum
CREATE TYPE "trip_status" AS ENUM ('PLANNED', 'DEPARTED', 'ARRIVED', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "trip_expense_status" AS ENUM ('POSTED', 'CANCELLED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "journal_source" ADD VALUE 'TRIP_EXPENSE';
ALTER TYPE "journal_source" ADD VALUE 'TRIP_ACCRUAL';

-- CreateTable
CREATE TABLE "vehicles" (
    "id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "plate_number" VARCHAR(30) NOT NULL,
    "vehicle_type" VARCHAR(100) NOT NULL,
    "capacity_kg" DECIMAL(12,3),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "vehicles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "drivers" (
    "id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "phone" VARCHAR(20),
    "license_number" VARCHAR(50),
    "user_id" UUID,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "drivers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "carriers" (
    "id" UUID NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "phone" VARCHAR(20),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "carriers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trips" (
    "id" UUID NOT NULL,
    "number" VARCHAR(30) NOT NULL,
    "branch_id" UUID NOT NULL,
    "kind" "trip_kind" NOT NULL,
    "status" "trip_status" NOT NULL DEFAULT 'PLANNED',
    "origin_location_id" UUID NOT NULL,
    "destination_location_id" UUID NOT NULL,
    "planned_departure" TIMESTAMPTZ(3),
    "planned_arrival" TIMESTAMPTZ(3),
    "actual_departure" TIMESTAMPTZ(3),
    "actual_arrival" TIMESTAMPTZ(3),
    "completed_at" TIMESTAMPTZ(3),
    "vehicle_id" UUID,
    "driver_id" UUID,
    "carrier_id" UUID,
    "agreed_cost" DECIMAL(18,4),
    "currency" CHAR(3),
    "external_vehicle" VARCHAR(100),
    "external_driver" VARCHAR(200),
    "accrual_entry_id" UUID,
    "notes" TEXT,
    "cancel_reason" TEXT,
    "cancelled_at" TIMESTAMPTZ(3),
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "trips_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trip_shipments" (
    "trip_id" UUID NOT NULL,
    "shipment_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "added_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trip_shipments_pkey" PRIMARY KEY ("trip_id","shipment_id")
);

-- CreateTable
CREATE TABLE "trip_expenses" (
    "id" UUID NOT NULL,
    "number" VARCHAR(30) NOT NULL,
    "branch_id" UUID NOT NULL,
    "trip_id" UUID NOT NULL,
    "expense_date" DATE NOT NULL,
    "description" VARCHAR(200) NOT NULL,
    "amount" DECIMAL(18,4) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "fx_rate" DECIMAL(18,8) NOT NULL,
    "cash_account_id" UUID NOT NULL,
    "status" "trip_expense_status" NOT NULL DEFAULT 'POSTED',
    "journal_entry_id" UUID NOT NULL,
    "cancel_journal_entry_id" UUID,
    "cancel_reason" TEXT,
    "cancelled_at" TIMESTAMPTZ(3),
    "cancelled_by_id" UUID,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trip_expenses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "proofs_of_delivery" (
    "id" UUID NOT NULL,
    "number" VARCHAR(30) NOT NULL,
    "branch_id" UUID NOT NULL,
    "shipment_id" UUID NOT NULL,
    "trip_id" UUID,
    "recipient_name" VARCHAR(200) NOT NULL,
    "recipient_capacity" VARCHAR(100) NOT NULL,
    "delivered_at" TIMESTAMPTZ(3) NOT NULL,
    "packages" INTEGER,
    "note" TEXT,
    "status_applied" "shipment_status",
    "signature_document_id" UUID NOT NULL,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "proofs_of_delivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pod_photos" (
    "pod_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,

    CONSTRAINT "pod_photos_pkey" PRIMARY KEY ("pod_id","document_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "vehicles_plate_number_key" ON "vehicles"("plate_number");

-- CreateIndex
CREATE INDEX "vehicles_branch_id_idx" ON "vehicles"("branch_id");

-- CreateIndex
CREATE UNIQUE INDEX "drivers_user_id_key" ON "drivers"("user_id");

-- CreateIndex
CREATE INDEX "drivers_branch_id_idx" ON "drivers"("branch_id");

-- CreateIndex
CREATE UNIQUE INDEX "carriers_name_key" ON "carriers"("name");

-- CreateIndex
CREATE UNIQUE INDEX "trips_number_key" ON "trips"("number");

-- CreateIndex
CREATE UNIQUE INDEX "trips_accrual_entry_id_key" ON "trips"("accrual_entry_id");

-- CreateIndex
CREATE INDEX "trips_branch_id_status_idx" ON "trips"("branch_id", "status");

-- CreateIndex
CREATE INDEX "trips_driver_id_idx" ON "trips"("driver_id");

-- CreateIndex
CREATE INDEX "trip_shipments_shipment_id_idx" ON "trip_shipments"("shipment_id");

-- CreateIndex
CREATE INDEX "trip_shipments_branch_id_idx" ON "trip_shipments"("branch_id");

-- CreateIndex
CREATE UNIQUE INDEX "trip_expenses_number_key" ON "trip_expenses"("number");

-- CreateIndex
CREATE UNIQUE INDEX "trip_expenses_journal_entry_id_key" ON "trip_expenses"("journal_entry_id");

-- CreateIndex
CREATE UNIQUE INDEX "trip_expenses_cancel_journal_entry_id_key" ON "trip_expenses"("cancel_journal_entry_id");

-- CreateIndex
CREATE INDEX "trip_expenses_trip_id_idx" ON "trip_expenses"("trip_id");

-- CreateIndex
CREATE INDEX "trip_expenses_branch_id_idx" ON "trip_expenses"("branch_id");

-- CreateIndex
CREATE UNIQUE INDEX "proofs_of_delivery_number_key" ON "proofs_of_delivery"("number");

-- CreateIndex
CREATE UNIQUE INDEX "proofs_of_delivery_signature_document_id_key" ON "proofs_of_delivery"("signature_document_id");

-- CreateIndex
CREATE INDEX "proofs_of_delivery_shipment_id_idx" ON "proofs_of_delivery"("shipment_id");

-- CreateIndex
CREATE INDEX "proofs_of_delivery_trip_id_idx" ON "proofs_of_delivery"("trip_id");

-- CreateIndex
CREATE INDEX "proofs_of_delivery_branch_id_idx" ON "proofs_of_delivery"("branch_id");

-- CreateIndex
CREATE UNIQUE INDEX "pod_photos_document_id_key" ON "pod_photos"("document_id");

-- CreateIndex
CREATE INDEX "pod_photos_branch_id_idx" ON "pod_photos"("branch_id");

-- AddForeignKey
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drivers" ADD CONSTRAINT "drivers_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drivers" ADD CONSTRAINT "drivers_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trips" ADD CONSTRAINT "trips_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trips" ADD CONSTRAINT "trips_origin_location_id_fkey" FOREIGN KEY ("origin_location_id") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trips" ADD CONSTRAINT "trips_destination_location_id_fkey" FOREIGN KEY ("destination_location_id") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trips" ADD CONSTRAINT "trips_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trips" ADD CONSTRAINT "trips_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "drivers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trips" ADD CONSTRAINT "trips_carrier_id_fkey" FOREIGN KEY ("carrier_id") REFERENCES "carriers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trips" ADD CONSTRAINT "trips_currency_fkey" FOREIGN KEY ("currency") REFERENCES "currencies"("code") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "trips" ADD CONSTRAINT "trips_accrual_entry_id_fkey" FOREIGN KEY ("accrual_entry_id") REFERENCES "journal_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trips" ADD CONSTRAINT "trips_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip_shipments" ADD CONSTRAINT "trip_shipments_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "trips"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip_shipments" ADD CONSTRAINT "trip_shipments_shipment_id_fkey" FOREIGN KEY ("shipment_id") REFERENCES "shipments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip_shipments" ADD CONSTRAINT "trip_shipments_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip_expenses" ADD CONSTRAINT "trip_expenses_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip_expenses" ADD CONSTRAINT "trip_expenses_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "trips"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip_expenses" ADD CONSTRAINT "trip_expenses_currency_fkey" FOREIGN KEY ("currency") REFERENCES "currencies"("code") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "trip_expenses" ADD CONSTRAINT "trip_expenses_cash_account_id_fkey" FOREIGN KEY ("cash_account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip_expenses" ADD CONSTRAINT "trip_expenses_journal_entry_id_fkey" FOREIGN KEY ("journal_entry_id") REFERENCES "journal_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip_expenses" ADD CONSTRAINT "trip_expenses_cancel_journal_entry_id_fkey" FOREIGN KEY ("cancel_journal_entry_id") REFERENCES "journal_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip_expenses" ADD CONSTRAINT "trip_expenses_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip_expenses" ADD CONSTRAINT "trip_expenses_cancelled_by_id_fkey" FOREIGN KEY ("cancelled_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "proofs_of_delivery" ADD CONSTRAINT "proofs_of_delivery_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "proofs_of_delivery" ADD CONSTRAINT "proofs_of_delivery_shipment_id_fkey" FOREIGN KEY ("shipment_id") REFERENCES "shipments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "proofs_of_delivery" ADD CONSTRAINT "proofs_of_delivery_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "trips"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "proofs_of_delivery" ADD CONSTRAINT "proofs_of_delivery_signature_document_id_fkey" FOREIGN KEY ("signature_document_id") REFERENCES "documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "proofs_of_delivery" ADD CONSTRAINT "proofs_of_delivery_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pod_photos" ADD CONSTRAINT "pod_photos_pod_id_fkey" FOREIGN KEY ("pod_id") REFERENCES "proofs_of_delivery"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pod_photos" ADD CONSTRAINT "pod_photos_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pod_photos" ADD CONSTRAINT "pod_photos_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Checks (raw SQL; Prisma does not model CHECK constraints).
-- Fleet master data: plates upper-cased, names and types not blank, capacities positive.
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_plate_check" CHECK ("plate_number" = upper(btrim("plate_number")) AND "plate_number" <> '');
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_type_check" CHECK (btrim("vehicle_type") <> '');
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_capacity_check" CHECK ("capacity_kg" IS NULL OR "capacity_kg" > 0);
ALTER TABLE "drivers" ADD CONSTRAINT "drivers_name_check" CHECK (btrim("name") <> '');
ALTER TABLE "carriers" ADD CONSTRAINT "carriers_name_check" CHECK (btrim("name") <> '');

-- A trip is either own (vehicle and driver) or external (carrier, agreed cost and currency, the
-- truck and driver as free text); never a mix.
ALTER TABLE "trips" ADD CONSTRAINT "trips_kind_check" CHECK (
    ("kind" = 'OWN'
        AND "vehicle_id" IS NOT NULL AND "driver_id" IS NOT NULL
        AND "carrier_id" IS NULL AND "agreed_cost" IS NULL AND "currency" IS NULL
        AND "external_vehicle" IS NULL AND "external_driver" IS NULL AND "accrual_entry_id" IS NULL)
    OR ("kind" = 'EXTERNAL'
        AND "vehicle_id" IS NULL AND "driver_id" IS NULL
        AND "carrier_id" IS NOT NULL AND "agreed_cost" IS NOT NULL AND "currency" IS NOT NULL)
);
ALTER TABLE "trips" ADD CONSTRAINT "trips_cost_check" CHECK ("agreed_cost" IS NULL OR "agreed_cost" > 0);
ALTER TABLE "trips" ADD CONSTRAINT "trips_route_check" CHECK ("origin_location_id" <> "destination_location_id");
-- Dates in order: arrival never before departure, planned and actual.
ALTER TABLE "trips" ADD CONSTRAINT "trips_planned_dates_check" CHECK (
    "planned_arrival" IS NULL OR "planned_departure" IS NULL OR "planned_arrival" >= "planned_departure"
);
ALTER TABLE "trips" ADD CONSTRAINT "trips_actual_dates_check" CHECK (
    "actual_arrival" IS NULL OR ("actual_departure" IS NOT NULL AND "actual_arrival" >= "actual_departure")
);
-- The status and its timestamps agree: a departed trip has left, an arrived one has arrived,
-- a planned or cancelled one has not left (cancelling is possible only before departure).
ALTER TABLE "trips" ADD CONSTRAINT "trips_status_check" CHECK (
    ("status" IN ('PLANNED', 'CANCELLED') AND "actual_departure" IS NULL AND "actual_arrival" IS NULL)
    OR ("status" = 'DEPARTED' AND "actual_departure" IS NOT NULL AND "actual_arrival" IS NULL)
    OR ("status" IN ('ARRIVED', 'COMPLETED') AND "actual_arrival" IS NOT NULL)
);
ALTER TABLE "trips" ADD CONSTRAINT "trips_completed_check" CHECK (
    ("status" = 'COMPLETED') = ("completed_at" IS NOT NULL)
);
ALTER TABLE "trips" ADD CONSTRAINT "trips_cancelled_check" CHECK (
    ("status" = 'CANCELLED') = ("cancelled_at" IS NOT NULL AND "cancel_reason" IS NOT NULL)
);
-- Rule 11: a completed external trip has its accrual entry, and only then.
ALTER TABLE "trips" ADD CONSTRAINT "trips_accrual_check" CHECK (
    ("kind" = 'EXTERNAL' AND "status" = 'COMPLETED') = ("accrual_entry_id" IS NOT NULL)
);

-- Rule 10 expenses: positive amount and rate; a cancelled one has its reversing entry.
ALTER TABLE "trip_expenses" ADD CONSTRAINT "trip_expenses_amount_check" CHECK ("amount" > 0 AND "fx_rate" > 0);
ALTER TABLE "trip_expenses" ADD CONSTRAINT "trip_expenses_description_check" CHECK (btrim("description") <> '');
ALTER TABLE "trip_expenses" ADD CONSTRAINT "trip_expenses_cancel_check" CHECK (
    ("status" = 'CANCELLED') = ("cancelled_at" IS NOT NULL AND "cancelled_by_id" IS NOT NULL
        AND "cancel_journal_entry_id" IS NOT NULL AND "cancel_reason" IS NOT NULL)
);

-- Proof of delivery: a named recipient, whole packages, and only a delivery status applied.
ALTER TABLE "proofs_of_delivery" ADD CONSTRAINT "proofs_of_delivery_recipient_check" CHECK (
    btrim("recipient_name") <> '' AND btrim("recipient_capacity") <> ''
);
ALTER TABLE "proofs_of_delivery" ADD CONSTRAINT "proofs_of_delivery_packages_check" CHECK ("packages" IS NULL OR "packages" > 0);
ALTER TABLE "proofs_of_delivery" ADD CONSTRAINT "proofs_of_delivery_status_check" CHECK (
    "status_applied" IS NULL OR "status_applied" IN ('PARTIALLY_DELIVERED', 'DELIVERED')
);
