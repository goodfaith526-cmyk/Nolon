-- CreateEnum
CREATE TYPE "commission_basis" AS ENUM ('PERCENT_OF_PRICE', 'FIXED_PER_UNIT');

-- CreateEnum
CREATE TYPE "partner_contract_status" AS ENUM ('DRAFT', 'APPROVED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "rate_cost_component" AS ENUM ('ORIGIN_HANDLING', 'SEA_FREIGHT', 'DISTRIBUTION', 'OTHER');

-- CreateEnum
CREATE TYPE "rate_cost_status" AS ENUM ('ENTERED', 'NOT_APPLICABLE');

-- CreateTable
CREATE TABLE "partner_contracts" (
    "id" UUID NOT NULL,
    "partner_id" UUID NOT NULL,
    "price_category_code" VARCHAR(20),
    "basis" "commission_basis" NOT NULL,
    "value" DECIMAL(18,4) NOT NULL,
    "unit" "rate_unit",
    "currency" CHAR(3),
    "valid_from" DATE NOT NULL,
    "valid_to" DATE,
    "notes" TEXT,
    "status" "partner_contract_status" NOT NULL DEFAULT 'DRAFT',
    "approved_by_id" UUID,
    "approved_at" TIMESTAMPTZ(3),
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "partner_contracts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rate_card_costs" (
    "id" UUID NOT NULL,
    "rate_card_id" UUID NOT NULL,
    "component" "rate_cost_component" NOT NULL,
    "status" "rate_cost_status" NOT NULL,
    "amount" DECIMAL(18,4),
    "currency" CHAR(3),
    "unit" "rate_unit",
    "units_per_cost_unit" DECIMAL(18,4),
    "note" TEXT,
    "updated_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "rate_card_costs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "partner_contracts_partner_id_status_idx" ON "partner_contracts"("partner_id", "status");

-- CreateIndex
CREATE INDEX "partner_contracts_price_category_code_idx" ON "partner_contracts"("price_category_code");

-- CreateIndex
CREATE INDEX "partner_contracts_currency_idx" ON "partner_contracts"("currency");

-- CreateIndex
CREATE INDEX "rate_card_costs_currency_idx" ON "rate_card_costs"("currency");

-- CreateIndex
CREATE UNIQUE INDEX "rate_card_costs_rate_card_id_component_key" ON "rate_card_costs"("rate_card_id", "component");

-- AddForeignKey
ALTER TABLE "partner_contracts" ADD CONSTRAINT "partner_contracts_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_contracts" ADD CONSTRAINT "partner_contracts_price_category_code_fkey" FOREIGN KEY ("price_category_code") REFERENCES "price_categories"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_contracts" ADD CONSTRAINT "partner_contracts_currency_fkey" FOREIGN KEY ("currency") REFERENCES "currencies"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_contracts" ADD CONSTRAINT "partner_contracts_approved_by_id_fkey" FOREIGN KEY ("approved_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_contracts" ADD CONSTRAINT "partner_contracts_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_card_costs" ADD CONSTRAINT "rate_card_costs_rate_card_id_fkey" FOREIGN KEY ("rate_card_id") REFERENCES "rate_cards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_card_costs" ADD CONSTRAINT "rate_card_costs_currency_fkey" FOREIGN KEY ("currency") REFERENCES "currencies"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_card_costs" ADD CONSTRAINT "rate_card_costs_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A percentage has no unit or currency and is at most 100; a fixed amount names both.
ALTER TABLE "partner_contracts" ADD CONSTRAINT "partner_contracts_value_check" CHECK (
    "value" >= 0 AND (
        ("basis" = 'PERCENT_OF_PRICE' AND "unit" IS NULL AND "currency" IS NULL AND "value" <= 100)
        OR ("basis" = 'FIXED_PER_UNIT' AND "unit" IS NOT NULL AND "currency" IS NOT NULL)
    )
);
ALTER TABLE "partner_contracts" ADD CONSTRAINT "partner_contracts_validity_check" CHECK (
    "valid_to" IS NULL OR "valid_to" >= "valid_from"
);

-- An entered cost has an amount, currency and unit; a cost marked not applicable has none.
ALTER TABLE "rate_card_costs" ADD CONSTRAINT "rate_card_costs_amount_check" CHECK (
    ("status" = 'ENTERED' AND "amount" IS NOT NULL AND "amount" >= 0
        AND "currency" IS NOT NULL AND "unit" IS NOT NULL)
    OR ("status" = 'NOT_APPLICABLE' AND "amount" IS NULL AND "currency" IS NULL
        AND "unit" IS NULL AND "units_per_cost_unit" IS NULL)
);
ALTER TABLE "rate_card_costs" ADD CONSTRAINT "rate_card_costs_units_check" CHECK (
    "units_per_cost_unit" IS NULL OR "units_per_cost_unit" > 0
);
