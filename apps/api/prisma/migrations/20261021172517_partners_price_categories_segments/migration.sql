-- CreateEnum
CREATE TYPE "partner_kind" AS ENUM ('SALES_OUTLET', 'ORIGIN_CONSOLIDATOR', 'OVERSEAS_AGENT', 'DISTRIBUTOR');

-- CreateTable
CREATE TABLE "partners" (
    "id" UUID NOT NULL,
    "number" VARCHAR(30) NOT NULL,
    "kind" "partner_kind" NOT NULL,
    "branch_id" UUID NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "phone" VARCHAR(20),
    "email" VARCHAR(254),
    "country_code" CHAR(2) NOT NULL,
    "location_id" UUID,
    "supplier_id" UUID,
    "currency" CHAR(3) NOT NULL,
    "notes" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "partners_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "price_categories" (
    "code" VARCHAR(20) NOT NULL,
    "name_en" TEXT NOT NULL,
    "name_ar" TEXT NOT NULL,
    "cargo_type" "cargo_type" NOT NULL,
    "default_unit" "rate_unit" NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "price_categories_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "customer_segments" (
    "code" VARCHAR(20) NOT NULL,
    "name_en" TEXT NOT NULL,
    "name_ar" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_segments_pkey" PRIMARY KEY ("code")
);

-- CreateIndex
CREATE UNIQUE INDEX "partners_number_key" ON "partners"("number");

-- CreateIndex
CREATE INDEX "partners_branch_id_kind_idx" ON "partners"("branch_id", "kind");

-- CreateIndex
CREATE INDEX "partners_location_id_idx" ON "partners"("location_id");

-- CreateIndex
CREATE INDEX "partners_supplier_id_idx" ON "partners"("supplier_id");

-- AddForeignKey
ALTER TABLE "partners" ADD CONSTRAINT "partners_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partners" ADD CONSTRAINT "partners_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partners" ADD CONSTRAINT "partners_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partners" ADD CONSTRAINT "partners_currency_fkey" FOREIGN KEY ("currency") REFERENCES "currencies"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partners" ADD CONSTRAINT "partners_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Seed: the price categories and customer segments of the business model (the client adds more).
INSERT INTO "price_categories" ("code", "name_en", "name_ar", "cargo_type", "default_unit") VALUES
    ('CARTON', 'Carton / parcel', 'كرتون / طرد', 'GENERAL', 'PER_PIECE'),
    ('BARREL', 'Barrel', 'برميل', 'BARREL', 'PER_BARREL'),
    ('PALLET', 'Pallet', 'باليت', 'PALLET', 'PER_PALLET'),
    ('SPECIAL', 'Special shipment', 'شحنة خاصة', 'GENERAL', 'PER_SHIPMENT');

INSERT INTO "customer_segments" ("code", "name_en", "name_ar") VALUES
    ('INDIVIDUAL', 'Individuals and families', 'أفراد وأسر'),
    ('MERCHANT', 'Merchants and importers', 'تجار ومستوردون'),
    ('BUSINESS', 'Companies and online shops', 'شركات ومتاجر إلكترونية');
