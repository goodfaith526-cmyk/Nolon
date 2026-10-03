-- CreateEnum
CREATE TYPE "shipment_status" AS ENUM ('CREATED', 'PICKUP_SCHEDULED', 'RECEIVED_ORIGIN_WAREHOUSE', 'CONSOLIDATED', 'LOADED', 'DEPARTED', 'IN_TRANSIT', 'ARRIVED_PORT', 'TRIP_SCHEDULED', 'ROAD_DEPARTED', 'ROAD_IN_TRANSIT', 'ROAD_ARRIVED', 'CUSTOMS_IN_PROGRESS', 'CUSTOMS_CLEARED', 'RECEIVED_DESTINATION_WAREHOUSE', 'OUT_FOR_DELIVERY', 'PARTIALLY_DELIVERED', 'DELIVERED', 'CLOSED', 'ON_HOLD', 'CANCELLED');

-- CreateEnum
CREATE TYPE "event_source" AS ENUM ('USER', 'API', 'SYSTEM');

-- CreateEnum
CREATE TYPE "shipment_event_kind" AS ENUM ('CREATED', 'STATUS', 'HOLD', 'RESUME', 'REVERT', 'CANCEL');

-- CreateTable
CREATE TABLE "shipments" (
    "id" UUID NOT NULL,
    "number" VARCHAR(30) NOT NULL,
    "branch_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "booking_id" UUID NOT NULL,
    "origin_location_id" UUID NOT NULL,
    "destination_location_id" UUID NOT NULL,
    "mode" "shipping_mode" NOT NULL,
    "load_type" "load_type",
    "cargo_type" "cargo_type" NOT NULL,
    "cargo_description" TEXT,
    "services" "booking_service"[] NOT NULL,
    "shipper_id" UUID,
    "consignee_id" UUID,
    "notify_party_id" UUID,
    "status" "shipment_status" NOT NULL DEFAULT 'CREATED',
    "status_before_hold" "shipment_status",
    "hold_reason" TEXT,
    "cancel_reason" TEXT,
    "current_location_id" UUID,
    "carrier_name" VARCHAR(200),
    "vessel_name" VARCHAR(200),
    "voyage_number" VARCHAR(50),
    "bl_number" VARCHAR(50),
    "etd" DATE,
    "eta" DATE,
    "tracking_token" VARCHAR(64) NOT NULL,
    "created_by_id" UUID NOT NULL,
    "closed_at" TIMESTAMPTZ(3),
    "cancelled_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "shipments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shipment_items" (
    "id" UUID NOT NULL,
    "shipment_id" UUID NOT NULL,
    "line_no" SMALLINT NOT NULL,
    "cargo_type" "cargo_type" NOT NULL,
    "container_type_code" VARCHAR(10),
    "description" TEXT,
    "quantity" INTEGER NOT NULL,
    "length_cm" DECIMAL(10,2),
    "width_cm" DECIMAL(10,2),
    "height_cm" DECIMAL(10,2),
    "weight_kg" DECIMAL(12,3),
    "volume_cbm" DECIMAL(12,4),

    CONSTRAINT "shipment_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shipment_containers" (
    "id" UUID NOT NULL,
    "shipment_id" UUID NOT NULL,
    "container_number" VARCHAR(11) NOT NULL,
    "seal_number" VARCHAR(30),
    "container_type_code" VARCHAR(10) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shipment_containers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shipment_events" (
    "id" BIGSERIAL NOT NULL,
    "shipment_id" UUID NOT NULL,
    "kind" "shipment_event_kind" NOT NULL,
    "status" "shipment_status" NOT NULL,
    "from_status" "shipment_status",
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "branch_id" UUID NOT NULL,
    "location_id" UUID,
    "user_id" UUID,
    "source" "event_source" NOT NULL,
    "note" TEXT,
    "reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shipment_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_types" (
    "code" VARCHAR(30) NOT NULL,
    "name_en" TEXT NOT NULL,
    "name_ar" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_types_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "documents" (
    "id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "shipment_id" UUID NOT NULL,
    "type_code" VARCHAR(30) NOT NULL,
    "file_name" VARCHAR(255) NOT NULL,
    "content_type" VARCHAR(100) NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "note" TEXT,
    "uploaded_by_id" UUID NOT NULL,
    "uploaded_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(3),
    "deleted_by_id" UUID,

    CONSTRAINT "documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_contents" (
    "document_id" UUID NOT NULL,
    "data" BYTEA NOT NULL,

    CONSTRAINT "document_contents_pkey" PRIMARY KEY ("document_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "shipments_number_key" ON "shipments"("number");

-- CreateIndex
CREATE UNIQUE INDEX "shipments_booking_id_key" ON "shipments"("booking_id");

-- CreateIndex
CREATE UNIQUE INDEX "shipments_tracking_token_key" ON "shipments"("tracking_token");

-- CreateIndex
CREATE INDEX "shipments_branch_id_status_idx" ON "shipments"("branch_id", "status");

-- CreateIndex
CREATE INDEX "shipments_customer_id_idx" ON "shipments"("customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "shipment_items_shipment_id_line_no_key" ON "shipment_items"("shipment_id", "line_no");

-- CreateIndex
CREATE UNIQUE INDEX "shipment_containers_shipment_id_container_number_key" ON "shipment_containers"("shipment_id", "container_number");

-- CreateIndex
CREATE INDEX "shipment_events_shipment_id_id_idx" ON "shipment_events"("shipment_id", "id");

-- CreateIndex
CREATE INDEX "documents_shipment_id_idx" ON "documents"("shipment_id");

-- CreateIndex
CREATE INDEX "documents_branch_id_idx" ON "documents"("branch_id");

-- AddForeignKey
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_origin_location_id_fkey" FOREIGN KEY ("origin_location_id") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_destination_location_id_fkey" FOREIGN KEY ("destination_location_id") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_current_location_id_fkey" FOREIGN KEY ("current_location_id") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_shipper_id_fkey" FOREIGN KEY ("shipper_id") REFERENCES "parties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_consignee_id_fkey" FOREIGN KEY ("consignee_id") REFERENCES "parties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_notify_party_id_fkey" FOREIGN KEY ("notify_party_id") REFERENCES "parties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_items" ADD CONSTRAINT "shipment_items_shipment_id_fkey" FOREIGN KEY ("shipment_id") REFERENCES "shipments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_items" ADD CONSTRAINT "shipment_items_container_type_code_fkey" FOREIGN KEY ("container_type_code") REFERENCES "container_types"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_containers" ADD CONSTRAINT "shipment_containers_shipment_id_fkey" FOREIGN KEY ("shipment_id") REFERENCES "shipments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_containers" ADD CONSTRAINT "shipment_containers_container_type_code_fkey" FOREIGN KEY ("container_type_code") REFERENCES "container_types"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_events" ADD CONSTRAINT "shipment_events_shipment_id_fkey" FOREIGN KEY ("shipment_id") REFERENCES "shipments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_events" ADD CONSTRAINT "shipment_events_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_events" ADD CONSTRAINT "shipment_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_shipment_id_fkey" FOREIGN KEY ("shipment_id") REFERENCES "shipments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_type_code_fkey" FOREIGN KEY ("type_code") REFERENCES "document_types"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_uploaded_by_id_fkey" FOREIGN KEY ("uploaded_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_deleted_by_id_fkey" FOREIGN KEY ("deleted_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_contents" ADD CONSTRAINT "document_contents_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Raw SQL (not expressible in schema.prisma): data rules the database enforces as a last line of
-- defence. The services check the same rules first and return readable errors.
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_route_check" CHECK ("origin_location_id" <> "destination_location_id");
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_load_type_check" CHECK (("mode" = 'SEA') OR ("load_type" IS NULL));
-- NOT NULL is on the column above: a CHECK on NULL passes, so it alone would not reject NULL.
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_services_check" CHECK (cardinality("services") >= 1);
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_dates_check" CHECK ("etd" IS NULL OR "eta" IS NULL OR "eta" >= "etd");
-- 24 random bytes in base64url: 32 characters. Short tokens could be guessed.
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_tracking_token_check" CHECK ("tracking_token" ~ '^[A-Za-z0-9_-]{32,64}$');
-- Status bookkeeping: hold, cancel and close fields are set exactly when the status says so.
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_hold_check" CHECK (
    ("status" = 'ON_HOLD') = ("status_before_hold" IS NOT NULL AND "hold_reason" IS NOT NULL)
    AND ("status" = 'ON_HOLD' OR ("status_before_hold" IS NULL AND "hold_reason" IS NULL))
    AND ("status_before_hold" IS NULL OR "status_before_hold" NOT IN ('ON_HOLD', 'CANCELLED', 'CLOSED')));
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_cancel_check" CHECK (
    ("status" = 'CANCELLED') = ("cancel_reason" IS NOT NULL AND "cancelled_at" IS NOT NULL)
    AND ("status" = 'CANCELLED' OR ("cancel_reason" IS NULL AND "cancelled_at" IS NULL)));
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_closed_check" CHECK (("status" = 'CLOSED') = ("closed_at" IS NOT NULL));

ALTER TABLE "shipment_items" ADD CONSTRAINT "shipment_items_amounts_check" CHECK (
    "line_no" >= 1 AND "quantity" > 0
    AND ("length_cm" IS NULL OR "length_cm" > 0)
    AND ("width_cm" IS NULL OR "width_cm" > 0)
    AND ("height_cm" IS NULL OR "height_cm" > 0)
    AND ("weight_kg" IS NULL OR "weight_kg" >= 0)
    AND ("volume_cbm" IS NULL OR "volume_cbm" >= 0));
-- ISO 6346: 4 letters (owner code and category) and 7 digits (serial and check digit).
ALTER TABLE "shipment_containers" ADD CONSTRAINT "shipment_containers_number_check" CHECK ("container_number" ~ '^[A-Z]{4}[0-9]{7}$');

ALTER TABLE "shipment_events" ADD CONSTRAINT "shipment_events_reason_check" CHECK (
    "kind" NOT IN ('HOLD', 'REVERT', 'CANCEL') OR ("reason" IS NOT NULL AND btrim("reason") <> ''));
ALTER TABLE "shipment_events" ADD CONSTRAINT "shipment_events_user_check" CHECK ("source" <> 'USER' OR "user_id" IS NOT NULL);

ALTER TABLE "document_types" ADD CONSTRAINT "document_types_code_check" CHECK ("code" = upper(btrim("code")) AND "code" <> '');
-- 10 MB per file; the API rejects larger uploads before they reach the database.
ALTER TABLE "documents" ADD CONSTRAINT "documents_size_check" CHECK ("size_bytes" BETWEEN 1 AND 10485760);
ALTER TABLE "documents" ADD CONSTRAINT "documents_sha256_check" CHECK ("sha256" ~ '^[0-9a-f]{64}$');
ALTER TABLE "documents" ADD CONSTRAINT "documents_deleted_check" CHECK (("deleted_at" IS NULL) = ("deleted_by_id" IS NULL));
ALTER TABLE "document_contents" ADD CONSTRAINT "document_contents_size_check" CHECK (octet_length("data") BETWEEN 1 AND 10485760);

-- Hand-written: initial document types (annex: documents per shipment). The client adds more as
-- rows, not code.
INSERT INTO "document_types" ("code", "name_en", "name_ar") VALUES
    ('BL', 'Bill of lading', 'بوليصة الشحن'),
    ('COMMERCIAL_INVOICE', 'Commercial invoice', 'الفاتورة التجارية'),
    ('PACKING_LIST', 'Packing list', 'قائمة التعبئة'),
    ('CERTIFICATE_OF_ORIGIN', 'Certificate of origin', 'شهادة المنشأ'),
    ('CUSTOMS', 'Customs declaration', 'البيان الجمركي'),
    ('POD', 'Proof of delivery', 'إثبات التسليم'),
    ('PHOTO', 'Photo', 'صورة'),
    ('OTHER', 'Other', 'أخرى')
ON CONFLICT ("code") DO NOTHING;
