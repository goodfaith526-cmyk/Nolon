-- Business model batch 2 (docs/plans/07-business-model-batch-2.md, sections 3.1-3.4): partner
-- commissions accrued per shipment (rule 16) and settled by a partner statement's supplier bill
-- (rule 16a). NOT additive: it adds values to the accounting types posting_role, journal_source and
-- supplier_bill_line_kind and a nullable column to supplier_bill_lines (owner sign-off, AGENTS.md
-- rule 4). Nothing is dropped, no existing column changes, the posted-entry triggers are untouched.
-- The new posting roles are mapped in the next migration (a new enum value cannot be used in the
-- transaction that adds it).

-- CreateEnum
CREATE TYPE "commission_event" AS ENUM ('INVOICED', 'DEPARTED', 'DELIVERED');

-- CreateEnum
CREATE TYPE "commission_role" AS ENUM ('SALES_OUTLET', 'ORIGIN_CONSOLIDATOR', 'DISTRIBUTOR');

-- CreateEnum
CREATE TYPE "commission_accrual_kind" AS ENUM ('ACCRUAL', 'ADJUSTMENT', 'REVERSAL', 'MANUAL');

-- CreateEnum
CREATE TYPE "partner_statement_status" AS ENUM ('DRAFT', 'BILLED', 'SETTLED', 'CANCELLED');

-- AlterEnum
ALTER TYPE "journal_source" ADD VALUE 'COMMISSION_ACCRUAL';

-- AlterEnum
ALTER TYPE "posting_role" ADD VALUE 'COMMISSION_COST';
ALTER TYPE "posting_role" ADD VALUE 'ACCRUED_COMMISSIONS';

-- AlterEnum
ALTER TYPE "supplier_bill_line_kind" ADD VALUE 'COMMISSION';

-- AlterTable
ALTER TABLE "partner_contracts" ADD COLUMN     "accrual_event" "commission_event" NOT NULL DEFAULT 'INVOICED';

-- AlterTable
ALTER TABLE "supplier_bill_lines" ADD COLUMN     "statement_id" UUID;

-- CreateTable
CREATE TABLE "commission_accruals" (
    "id" UUID NOT NULL,
    "shipment_id" UUID NOT NULL,
    "partner_id" UUID NOT NULL,
    "contract_id" UUID,
    "role" "commission_role" NOT NULL,
    "kind" "commission_accrual_kind" NOT NULL,
    "branch_id" UUID NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "base" DECIMAL(18,4),
    "quantity" DECIMAL(18,4),
    "fx_rate" DECIMAL(18,8),
    "amount" DECIMAL(18,4) NOT NULL,
    "amount_usd" DECIMAL(18,4) NOT NULL,
    "entry_id" UUID NOT NULL,
    "statement_id" UUID,
    "reason" TEXT,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "commission_accruals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commission_holds" (
    "shipment_id" UUID NOT NULL,
    "role" "commission_role" NOT NULL,
    "partner_id" UUID NOT NULL,
    "code" VARCHAR(60) NOT NULL,
    "detail" TEXT,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "commission_holds_pkey" PRIMARY KEY ("shipment_id","role")
);

-- CreateTable
CREATE TABLE "partner_statements" (
    "id" UUID NOT NULL,
    "number" VARCHAR(30) NOT NULL,
    "partner_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "period_to" DATE NOT NULL,
    "total" DECIMAL(18,4) NOT NULL,
    "total_usd" DECIMAL(18,4) NOT NULL,
    "status" "partner_statement_status" NOT NULL DEFAULT 'DRAFT',
    "bill_id" UUID,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "partner_statements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "commission_accruals_shipment_id_role_idx" ON "commission_accruals"("shipment_id", "role");

-- CreateIndex
CREATE INDEX "commission_accruals_partner_id_branch_id_currency_statement_idx" ON "commission_accruals"("partner_id", "branch_id", "currency", "statement_id");

-- CreateIndex
CREATE INDEX "commission_accruals_entry_id_idx" ON "commission_accruals"("entry_id");

-- CreateIndex
CREATE INDEX "commission_accruals_statement_id_idx" ON "commission_accruals"("statement_id");

-- CreateIndex
CREATE INDEX "commission_holds_partner_id_idx" ON "commission_holds"("partner_id");

-- CreateIndex
CREATE UNIQUE INDEX "partner_statements_number_key" ON "partner_statements"("number");

-- CreateIndex
CREATE UNIQUE INDEX "partner_statements_bill_id_key" ON "partner_statements"("bill_id");

-- CreateIndex
CREATE INDEX "partner_statements_partner_id_branch_id_status_idx" ON "partner_statements"("partner_id", "branch_id", "status");

-- CreateIndex
CREATE INDEX "supplier_bill_lines_statement_id_idx" ON "supplier_bill_lines"("statement_id");

-- AddForeignKey
ALTER TABLE "commission_accruals" ADD CONSTRAINT "commission_accruals_shipment_id_fkey" FOREIGN KEY ("shipment_id") REFERENCES "shipments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commission_accruals" ADD CONSTRAINT "commission_accruals_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commission_accruals" ADD CONSTRAINT "commission_accruals_contract_id_fkey" FOREIGN KEY ("contract_id") REFERENCES "partner_contracts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commission_accruals" ADD CONSTRAINT "commission_accruals_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commission_accruals" ADD CONSTRAINT "commission_accruals_currency_fkey" FOREIGN KEY ("currency") REFERENCES "currencies"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commission_accruals" ADD CONSTRAINT "commission_accruals_entry_id_fkey" FOREIGN KEY ("entry_id") REFERENCES "journal_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commission_accruals" ADD CONSTRAINT "commission_accruals_statement_id_fkey" FOREIGN KEY ("statement_id") REFERENCES "partner_statements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commission_accruals" ADD CONSTRAINT "commission_accruals_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commission_holds" ADD CONSTRAINT "commission_holds_shipment_id_fkey" FOREIGN KEY ("shipment_id") REFERENCES "shipments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commission_holds" ADD CONSTRAINT "commission_holds_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_statements" ADD CONSTRAINT "partner_statements_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_statements" ADD CONSTRAINT "partner_statements_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_statements" ADD CONSTRAINT "partner_statements_currency_fkey" FOREIGN KEY ("currency") REFERENCES "currencies"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_statements" ADD CONSTRAINT "partner_statements_bill_id_fkey" FOREIGN KEY ("bill_id") REFERENCES "supplier_bills"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_statements" ADD CONSTRAINT "partner_statements_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_bill_lines" ADD CONSTRAINT "supplier_bill_lines_statement_id_fkey" FOREIGN KEY ("statement_id") REFERENCES "partner_statements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------------------------
-- Commission rows never change their amounts (plan 07, 3.2): the only UPDATE allowed sets or clears
-- statement_id (a statement taking or releasing its rows); DELETE and TRUNCATE are refused.
-- ---------------------------------------------------------------------------------------------

ALTER TABLE "commission_accruals" ADD CONSTRAINT "commission_accruals_manual_reason_check"
    CHECK ("kind" <> 'MANUAL' OR length(btrim(coalesce("reason", ''))) BETWEEN 3 AND 500);

ALTER TABLE "partner_statements" ADD CONSTRAINT "partner_statements_positive_check"
    CHECK ("total" > 0 AND "total_usd" > 0);

ALTER TABLE "partner_statements" ADD CONSTRAINT "partner_statements_bill_check"
    CHECK (("status" IN ('BILLED', 'SETTLED')) = ("bill_id" IS NOT NULL));

CREATE FUNCTION "commission_accruals_amounts_fixed"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'UPDATE'
        AND (to_jsonb(NEW) - 'statement_id') = (to_jsonb(OLD) - 'statement_id') THEN
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Commission rows cannot be changed or deleted, only taken into or released from a statement';
END;
$$;

CREATE TRIGGER "commission_accruals_amounts_fixed"
    BEFORE UPDATE OR DELETE ON "commission_accruals"
    FOR EACH ROW EXECUTE FUNCTION "commission_accruals_amounts_fixed"();

CREATE TRIGGER "commission_accruals_no_truncate"
    BEFORE TRUNCATE ON "commission_accruals"
    FOR EACH STATEMENT EXECUTE FUNCTION "commission_accruals_amounts_fixed"();
