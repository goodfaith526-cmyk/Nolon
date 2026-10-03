-- CreateEnum
CREATE TYPE "location_kind" AS ENUM ('PORT', 'CITY', 'BORDER', 'OTHER');

-- CreateEnum
CREATE TYPE "shipping_mode" AS ENUM ('SEA', 'ROAD');

-- CreateEnum
CREATE TYPE "load_type" AS ENUM ('FCL', 'LCL');

-- CreateEnum
CREATE TYPE "cargo_type" AS ENUM ('CONTAINER', 'PALLET', 'BARREL', 'GENERAL');

-- CreateEnum
CREATE TYPE "rate_unit" AS ENUM ('PER_CONTAINER', 'PER_CBM', 'PER_KG', 'PER_PALLET', 'PER_BARREL', 'PER_PIECE', 'PER_SHIPMENT');

-- CreateEnum
CREATE TYPE "customer_kind" AS ENUM ('INDIVIDUAL', 'COMPANY');

-- CreateEnum
CREATE TYPE "rate_status" AS ENUM ('DRAFT', 'APPROVED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "quotation_status" AS ENUM ('DRAFT', 'SENT', 'APPROVED', 'REJECTED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "booking_status" AS ENUM ('DRAFT', 'CONFIRMED', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "booking_service" AS ENUM ('MAIN_FREIGHT', 'PICKUP', 'WAREHOUSE', 'CUSTOMS', 'INLAND_TRANSPORT', 'LAST_MILE');

-- CreateTable
CREATE TABLE "number_sequences" (
    "doc_type" VARCHAR(30) NOT NULL,
    "period_key" VARCHAR(10) NOT NULL DEFAULT '',
    "next_value" BIGINT NOT NULL DEFAULT 1,

    CONSTRAINT "number_sequences_pkey" PRIMARY KEY ("doc_type","period_key")
);

-- CreateTable
CREATE TABLE "locations" (
    "id" UUID NOT NULL,
    "code" VARCHAR(10) NOT NULL,
    "kind" "location_kind" NOT NULL,
    "name_en" TEXT NOT NULL,
    "name_ar" TEXT NOT NULL,
    "country_code" CHAR(2) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "locations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "container_types" (
    "code" VARCHAR(10) NOT NULL,
    "name_en" TEXT NOT NULL,
    "name_ar" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "container_types_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "charge_types" (
    "code" VARCHAR(20) NOT NULL,
    "name_en" TEXT NOT NULL,
    "name_ar" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "charge_types_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "customers" (
    "id" UUID NOT NULL,
    "number" VARCHAR(30) NOT NULL,
    "branch_id" UUID NOT NULL,
    "kind" "customer_kind" NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "company_name" VARCHAR(200),
    "phone" VARCHAR(20) NOT NULL,
    "whatsapp" VARCHAR(20),
    "email" VARCHAR(254),
    "country_code" CHAR(2),
    "city" VARCHAR(100),
    "address" TEXT,
    "tax_number" VARCHAR(50),
    "preferred_currency" CHAR(3),
    "preferred_locale" VARCHAR(5) NOT NULL DEFAULT 'ar',
    "payment_terms_days" INTEGER NOT NULL DEFAULT 0,
    "credit_limit" DECIMAL(18,4),
    "credit_limit_currency" CHAR(3),
    "notes" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_contacts" (
    "id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "position" VARCHAR(100),
    "phone" VARCHAR(20) NOT NULL,
    "email" VARCHAR(254),
    "id_number" VARCHAR(50),
    "can_inquire" BOOLEAN NOT NULL DEFAULT true,
    "can_receive_cargo" BOOLEAN NOT NULL DEFAULT false,
    "can_receive_documents" BOOLEAN NOT NULL DEFAULT false,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "customer_contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "parties" (
    "id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "company_name" VARCHAR(200),
    "phone" VARCHAR(20),
    "email" VARCHAR(254),
    "country_code" CHAR(2),
    "city" VARCHAR(100),
    "address" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "parties_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rate_cards" (
    "id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "origin_location_id" UUID NOT NULL,
    "destination_location_id" UUID NOT NULL,
    "mode" "shipping_mode" NOT NULL,
    "load_type" "load_type",
    "cargo_type" "cargo_type" NOT NULL,
    "container_type_code" VARCHAR(10),
    "charge_type_code" VARCHAR(20) NOT NULL DEFAULT 'FREIGHT',
    "unit" "rate_unit" NOT NULL,
    "price" DECIMAL(18,4) NOT NULL,
    "minimum_charge" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "currency" CHAR(3) NOT NULL,
    "valid_from" DATE NOT NULL,
    "valid_to" DATE,
    "transit_days" INTEGER,
    "notes" TEXT,
    "status" "rate_status" NOT NULL DEFAULT 'DRAFT',
    "approved_by_id" UUID,
    "approved_at" TIMESTAMPTZ(3),
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "rate_cards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quotations" (
    "id" UUID NOT NULL,
    "number" VARCHAR(30) NOT NULL,
    "branch_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "origin_location_id" UUID NOT NULL,
    "destination_location_id" UUID NOT NULL,
    "mode" "shipping_mode" NOT NULL,
    "load_type" "load_type",
    "cargo_type" "cargo_type" NOT NULL,
    "cargo_description" TEXT,
    "currency" CHAR(3) NOT NULL,
    "subtotal" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "discount_total" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "total" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "valid_until" DATE NOT NULL,
    "terms" TEXT,
    "status" "quotation_status" NOT NULL DEFAULT 'DRAFT',
    "rejection_reason" TEXT,
    "sent_at" TIMESTAMPTZ(3),
    "decided_at" TIMESTAMPTZ(3),
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "quotations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quotation_lines" (
    "id" UUID NOT NULL,
    "quotation_id" UUID NOT NULL,
    "line_no" SMALLINT NOT NULL,
    "charge_type_code" VARCHAR(20) NOT NULL,
    "description" TEXT,
    "rate_card_id" UUID,
    "unit" "rate_unit" NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "unit_price" DECIMAL(18,4) NOT NULL,
    "minimum_charge" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "discount" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "line_total" DECIMAL(18,4) NOT NULL,

    CONSTRAINT "quotation_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bookings" (
    "id" UUID NOT NULL,
    "number" VARCHAR(30) NOT NULL,
    "branch_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "quotation_id" UUID,
    "origin_location_id" UUID NOT NULL,
    "destination_location_id" UUID NOT NULL,
    "mode" "shipping_mode" NOT NULL,
    "load_type" "load_type",
    "cargo_type" "cargo_type" NOT NULL,
    "cargo_description" TEXT,
    "services" "booking_service"[],
    "shipper_id" UUID,
    "consignee_id" UUID,
    "notify_party_id" UUID,
    "requested_departure" DATE,
    "special_instructions" TEXT,
    "status" "booking_status" NOT NULL DEFAULT 'DRAFT',
    "cancel_reason" TEXT,
    "confirmed_at" TIMESTAMPTZ(3),
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "bookings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "booking_items" (
    "id" UUID NOT NULL,
    "booking_id" UUID NOT NULL,
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

    CONSTRAINT "booking_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "locations_code_key" ON "locations"("code");

-- CreateIndex
CREATE UNIQUE INDEX "customers_number_key" ON "customers"("number");

-- CreateIndex
CREATE INDEX "customers_branch_id_idx" ON "customers"("branch_id");

-- CreateIndex
CREATE INDEX "customers_phone_idx" ON "customers"("phone");

-- CreateIndex
CREATE INDEX "customer_contacts_customer_id_idx" ON "customer_contacts"("customer_id");

-- CreateIndex
CREATE INDEX "customer_contacts_phone_idx" ON "customer_contacts"("phone");

-- CreateIndex
CREATE INDEX "parties_customer_id_idx" ON "parties"("customer_id");

-- CreateIndex
CREATE INDEX "rate_cards_branch_id_status_idx" ON "rate_cards"("branch_id", "status");

-- CreateIndex
CREATE INDEX "rate_cards_origin_location_id_destination_location_id_mode_idx" ON "rate_cards"("origin_location_id", "destination_location_id", "mode");

-- CreateIndex
CREATE UNIQUE INDEX "quotations_number_key" ON "quotations"("number");

-- CreateIndex
CREATE INDEX "quotations_branch_id_status_idx" ON "quotations"("branch_id", "status");

-- CreateIndex
CREATE INDEX "quotations_customer_id_idx" ON "quotations"("customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "quotation_lines_quotation_id_line_no_key" ON "quotation_lines"("quotation_id", "line_no");

-- CreateIndex
CREATE UNIQUE INDEX "bookings_number_key" ON "bookings"("number");

-- CreateIndex
CREATE UNIQUE INDEX "bookings_quotation_id_key" ON "bookings"("quotation_id");

-- CreateIndex
CREATE INDEX "bookings_branch_id_status_idx" ON "bookings"("branch_id", "status");

-- CreateIndex
CREATE INDEX "bookings_customer_id_idx" ON "bookings"("customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "booking_items_booking_id_line_no_key" ON "booking_items"("booking_id", "line_no");

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_preferred_currency_fkey" FOREIGN KEY ("preferred_currency") REFERENCES "currencies"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_credit_limit_currency_fkey" FOREIGN KEY ("credit_limit_currency") REFERENCES "currencies"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_contacts" ADD CONSTRAINT "customer_contacts_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "parties" ADD CONSTRAINT "parties_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_cards" ADD CONSTRAINT "rate_cards_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_cards" ADD CONSTRAINT "rate_cards_origin_location_id_fkey" FOREIGN KEY ("origin_location_id") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_cards" ADD CONSTRAINT "rate_cards_destination_location_id_fkey" FOREIGN KEY ("destination_location_id") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_cards" ADD CONSTRAINT "rate_cards_container_type_code_fkey" FOREIGN KEY ("container_type_code") REFERENCES "container_types"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_cards" ADD CONSTRAINT "rate_cards_charge_type_code_fkey" FOREIGN KEY ("charge_type_code") REFERENCES "charge_types"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_cards" ADD CONSTRAINT "rate_cards_currency_fkey" FOREIGN KEY ("currency") REFERENCES "currencies"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_cards" ADD CONSTRAINT "rate_cards_approved_by_id_fkey" FOREIGN KEY ("approved_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_cards" ADD CONSTRAINT "rate_cards_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_origin_location_id_fkey" FOREIGN KEY ("origin_location_id") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_destination_location_id_fkey" FOREIGN KEY ("destination_location_id") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_currency_fkey" FOREIGN KEY ("currency") REFERENCES "currencies"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotation_lines" ADD CONSTRAINT "quotation_lines_quotation_id_fkey" FOREIGN KEY ("quotation_id") REFERENCES "quotations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotation_lines" ADD CONSTRAINT "quotation_lines_charge_type_code_fkey" FOREIGN KEY ("charge_type_code") REFERENCES "charge_types"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotation_lines" ADD CONSTRAINT "quotation_lines_rate_card_id_fkey" FOREIGN KEY ("rate_card_id") REFERENCES "rate_cards"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_quotation_id_fkey" FOREIGN KEY ("quotation_id") REFERENCES "quotations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_origin_location_id_fkey" FOREIGN KEY ("origin_location_id") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_destination_location_id_fkey" FOREIGN KEY ("destination_location_id") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_shipper_id_fkey" FOREIGN KEY ("shipper_id") REFERENCES "parties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_consignee_id_fkey" FOREIGN KEY ("consignee_id") REFERENCES "parties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_notify_party_id_fkey" FOREIGN KEY ("notify_party_id") REFERENCES "parties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking_items" ADD CONSTRAINT "booking_items_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking_items" ADD CONSTRAINT "booking_items_container_type_code_fkey" FOREIGN KEY ("container_type_code") REFERENCES "container_types"("code") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Raw SQL (not expressible in schema.prisma): data rules the database enforces as a last line of
-- defence. The services check the same rules first and return readable errors.
ALTER TABLE "number_sequences" ADD CONSTRAINT "number_sequences_next_value_check" CHECK ("next_value" >= 1);

ALTER TABLE "locations" ADD CONSTRAINT "locations_code_check" CHECK ("code" = upper(btrim("code")) AND "code" <> '');
ALTER TABLE "container_types" ADD CONSTRAINT "container_types_code_check" CHECK ("code" = upper(btrim("code")) AND "code" <> '');
ALTER TABLE "charge_types" ADD CONSTRAINT "charge_types_code_check" CHECK ("code" = upper(btrim("code")) AND "code" <> '');

-- Phone numbers are stored in international (E.164) form, e.g. +249912345678 (scope 6).
ALTER TABLE "customers" ADD CONSTRAINT "customers_phone_e164_check" CHECK ("phone" ~ '^\+[1-9][0-9]{6,14}$');
ALTER TABLE "customers" ADD CONSTRAINT "customers_whatsapp_e164_check" CHECK ("whatsapp" IS NULL OR "whatsapp" ~ '^\+[1-9][0-9]{6,14}$');
ALTER TABLE "customers" ADD CONSTRAINT "customers_preferred_locale_check" CHECK ("preferred_locale" IN ('ar', 'en'));
ALTER TABLE "customers" ADD CONSTRAINT "customers_payment_terms_check" CHECK ("payment_terms_days" BETWEEN 0 AND 365);
ALTER TABLE "customers" ADD CONSTRAINT "customers_credit_limit_check" CHECK (
    ("credit_limit" IS NULL AND "credit_limit_currency" IS NULL)
    OR ("credit_limit" >= 0 AND "credit_limit_currency" IS NOT NULL));
ALTER TABLE "customer_contacts" ADD CONSTRAINT "customer_contacts_phone_e164_check" CHECK ("phone" ~ '^\+[1-9][0-9]{6,14}$');
ALTER TABLE "parties" ADD CONSTRAINT "parties_phone_e164_check" CHECK ("phone" IS NULL OR "phone" ~ '^\+[1-9][0-9]{6,14}$');

ALTER TABLE "rate_cards" ADD CONSTRAINT "rate_cards_route_check" CHECK ("origin_location_id" <> "destination_location_id");
ALTER TABLE "rate_cards" ADD CONSTRAINT "rate_cards_amounts_check" CHECK ("price" >= 0 AND "minimum_charge" >= 0);
ALTER TABLE "rate_cards" ADD CONSTRAINT "rate_cards_validity_check" CHECK ("valid_to" IS NULL OR "valid_to" >= "valid_from");
ALTER TABLE "rate_cards" ADD CONSTRAINT "rate_cards_load_type_check" CHECK (("mode" = 'SEA') OR ("load_type" IS NULL));
ALTER TABLE "rate_cards" ADD CONSTRAINT "rate_cards_approval_check" CHECK (
    ("status" = 'DRAFT' AND "approved_by_id" IS NULL AND "approved_at" IS NULL)
    OR ("status" = 'APPROVED' AND "approved_by_id" IS NOT NULL AND "approved_at" IS NOT NULL)
    OR ("status" = 'CANCELLED'));

ALTER TABLE "quotations" ADD CONSTRAINT "quotations_route_check" CHECK ("origin_location_id" <> "destination_location_id");
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_totals_check" CHECK (
    "subtotal" >= 0 AND "discount_total" >= 0 AND "total" >= 0
    AND "total" = "subtotal" - "discount_total");
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_load_type_check" CHECK (("mode" = 'SEA') OR ("load_type" IS NULL));
ALTER TABLE "quotation_lines" ADD CONSTRAINT "quotation_lines_amounts_check" CHECK (
    "line_no" >= 1 AND "quantity" > 0 AND "unit_price" >= 0 AND "minimum_charge" >= 0 AND "discount" >= 0
    AND "line_total" >= 0);

ALTER TABLE "bookings" ADD CONSTRAINT "bookings_route_check" CHECK ("origin_location_id" <> "destination_location_id");
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_load_type_check" CHECK (("mode" = 'SEA') OR ("load_type" IS NULL));
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_services_check" CHECK (cardinality("services") >= 1);
ALTER TABLE "booking_items" ADD CONSTRAINT "booking_items_amounts_check" CHECK (
    "line_no" >= 1 AND "quantity" > 0
    AND ("length_cm" IS NULL OR "length_cm" > 0)
    AND ("width_cm" IS NULL OR "width_cm" > 0)
    AND ("height_cm" IS NULL OR "height_cm" > 0)
    AND ("weight_kg" IS NULL OR "weight_kg" >= 0)
    AND ("volume_cbm" IS NULL OR "volume_cbm" >= 0));

-- Hand-written: initial master data. Reference data needed in every environment, so it lives in
-- the migration (like the currency master). The client adds more as rows, not code.
INSERT INTO "container_types" ("code", "name_en", "name_ar") VALUES
    ('20GP', '20ft standard', 'حاوية 20 قدم'),
    ('40GP', '40ft standard', 'حاوية 40 قدم'),
    ('40HC', '40ft high cube', 'حاوية 40 قدم عالية'),
    ('OTHER', 'Other', 'أخرى')
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "charge_types" ("code", "name_en", "name_ar") VALUES
    ('FREIGHT', 'Freight', 'أجرة الشحن'),
    ('THC', 'Terminal handling', 'مناولة الميناء'),
    ('DOCS', 'Documentation', 'رسوم المستندات'),
    ('CUSTOMS', 'Customs clearance', 'التخليص الجمركي'),
    ('PICKUP', 'Pickup', 'الاستلام من المرسل'),
    ('INLAND', 'Inland transport', 'النقل الداخلي'),
    ('STORAGE', 'Warehouse storage', 'التخزين'),
    ('DELIVERY', 'Final delivery', 'التسليم النهائي'),
    ('OTHER', 'Other', 'أخرى')
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "locations" ("id", "code", "kind", "name_en", "name_ar", "country_code", "updated_at") VALUES
    (gen_random_uuid(), 'AEJEA', 'PORT', 'Jebel Ali', 'جبل علي', 'AE', CURRENT_TIMESTAMP),
    (gen_random_uuid(), 'AEDXB', 'CITY', 'Dubai', 'دبي', 'AE', CURRENT_TIMESTAMP),
    (gen_random_uuid(), 'SAJED', 'PORT', 'Jeddah', 'جدة', 'SA', CURRENT_TIMESTAMP),
    (gen_random_uuid(), 'SDPZU', 'PORT', 'Port Sudan', 'بورتسودان', 'SD', CURRENT_TIMESTAMP),
    (gen_random_uuid(), 'SDATB', 'CITY', 'Atbara', 'عطبرة', 'SD', CURRENT_TIMESTAMP),
    (gen_random_uuid(), 'SDKRT', 'CITY', 'Khartoum', 'الخرطوم', 'SD', CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO NOTHING;
