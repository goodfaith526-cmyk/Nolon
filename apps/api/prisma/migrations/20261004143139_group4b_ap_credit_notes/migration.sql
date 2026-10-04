-- CreateEnum
CREATE TYPE "credit_note_status" AS ENUM ('DRAFT', 'APPROVED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "supplier_bill_status" AS ENUM ('DRAFT', 'APPROVED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "supplier_bill_line_kind" AS ENUM ('SHIPMENT_COST', 'TRIP', 'EXPENSE');

-- CreateEnum
CREATE TYPE "supplier_payment_status" AS ENUM ('POSTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "expense_status" AS ENUM ('DRAFT', 'APPROVED', 'CANCELLED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "journal_source" ADD VALUE 'CREDIT_NOTE';
ALTER TYPE "journal_source" ADD VALUE 'SUPPLIER_BILL';
ALTER TYPE "journal_source" ADD VALUE 'SUPPLIER_PAYMENT';
ALTER TYPE "journal_source" ADD VALUE 'EXPENSE';
ALTER TYPE "journal_source" ADD VALUE 'OPENING_BALANCE';

-- AlterTable
ALTER TABLE "carriers" ADD COLUMN     "supplier_id" UUID;

-- AlterTable
ALTER TABLE "charge_type_postings" ADD COLUMN     "cost_account_id" UUID;

-- AlterTable
ALTER TABLE "customer_invoices" ADD COLUMN     "credited_amount" DECIMAL(18,4) NOT NULL DEFAULT 0,
ADD COLUMN     "credited_usd" DECIMAL(18,4) NOT NULL DEFAULT 0,
ADD COLUMN     "is_opening" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "reference" VARCHAR(50),
ALTER COLUMN "shipment_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "journal_lines" ADD COLUMN     "supplier_id" UUID,
ADD COLUMN     "trip_id" UUID;

-- AlterTable
ALTER TABLE "trips" ADD COLUMN     "carrier_bill_id" UUID;

-- CreateTable
CREATE TABLE "credit_notes" (
    "id" UUID NOT NULL,
    "number" VARCHAR(30),
    "branch_id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "credit_date" DATE NOT NULL,
    "amount" DECIMAL(18,4) NOT NULL,
    "amount_usd" DECIMAL(18,4),
    "reason" TEXT NOT NULL,
    "status" "credit_note_status" NOT NULL DEFAULT 'DRAFT',
    "journal_entry_id" UUID,
    "created_by_id" UUID NOT NULL,
    "approved_by_id" UUID,
    "approved_at" TIMESTAMPTZ(3),
    "cancel_reason" TEXT,
    "cancelled_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "credit_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "suppliers" (
    "id" UUID NOT NULL,
    "number" VARCHAR(30) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "phone" VARCHAR(20),
    "email" VARCHAR(254),
    "tax_number" VARCHAR(50),
    "payment_terms_days" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "suppliers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_bills" (
    "id" UUID NOT NULL,
    "number" VARCHAR(30),
    "branch_id" UUID NOT NULL,
    "supplier_id" UUID NOT NULL,
    "supplier_reference" VARCHAR(50),
    "is_opening" BOOLEAN NOT NULL DEFAULT false,
    "currency" CHAR(3) NOT NULL,
    "fx_rate" DECIMAL(18,8) NOT NULL,
    "bill_date" DATE NOT NULL,
    "due_date" DATE NOT NULL,
    "status" "supplier_bill_status" NOT NULL DEFAULT 'DRAFT',
    "total" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "total_usd" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "paid_amount" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "paid_usd" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "notes" TEXT,
    "journal_entry_id" UUID,
    "cancel_journal_entry_id" UUID,
    "payable_account_id" UUID,
    "created_by_id" UUID NOT NULL,
    "approved_by_id" UUID,
    "approved_at" TIMESTAMPTZ(3),
    "cancel_reason" TEXT,
    "cancelled_at" TIMESTAMPTZ(3),
    "cancelled_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "supplier_bills_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_bill_lines" (
    "id" UUID NOT NULL,
    "bill_id" UUID NOT NULL,
    "line_no" SMALLINT NOT NULL,
    "kind" "supplier_bill_line_kind" NOT NULL,
    "charge_type_code" VARCHAR(20),
    "shipment_id" UUID,
    "trip_id" UUID,
    "expense_category_code" VARCHAR(20),
    "description" TEXT,
    "amount" DECIMAL(18,4) NOT NULL,

    CONSTRAINT "supplier_bill_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_payments" (
    "id" UUID NOT NULL,
    "number" VARCHAR(30) NOT NULL,
    "branch_id" UUID NOT NULL,
    "supplier_id" UUID NOT NULL,
    "payment_date" DATE NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "fx_rate" DECIMAL(18,8) NOT NULL,
    "amount" DECIMAL(18,4) NOT NULL,
    "cash_account_id" UUID NOT NULL,
    "reference" VARCHAR(100),
    "notes" TEXT,
    "status" "supplier_payment_status" NOT NULL DEFAULT 'POSTED',
    "journal_entry_id" UUID NOT NULL,
    "cancel_journal_entry_id" UUID,
    "cancel_reason" TEXT,
    "cancelled_at" TIMESTAMPTZ(3),
    "cancelled_by_id" UUID,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supplier_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_payment_allocations" (
    "id" UUID NOT NULL,
    "payment_id" UUID NOT NULL,
    "bill_id" UUID NOT NULL,
    "amount" DECIMAL(18,4) NOT NULL,
    "relieved_usd" DECIMAL(18,4) NOT NULL,

    CONSTRAINT "supplier_payment_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expense_categories" (
    "code" VARCHAR(20) NOT NULL,
    "name_en" VARCHAR(200) NOT NULL,
    "name_ar" VARCHAR(200) NOT NULL,
    "account_id" UUID NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "expense_categories_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "expenses" (
    "id" UUID NOT NULL,
    "number" VARCHAR(30),
    "branch_id" UUID NOT NULL,
    "expense_date" DATE NOT NULL,
    "category_code" VARCHAR(20) NOT NULL,
    "description" VARCHAR(200) NOT NULL,
    "amount" DECIMAL(18,4) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "fx_rate" DECIMAL(18,8) NOT NULL,
    "cash_account_id" UUID NOT NULL,
    "reference" VARCHAR(100),
    "status" "expense_status" NOT NULL DEFAULT 'DRAFT',
    "journal_entry_id" UUID,
    "cancel_journal_entry_id" UUID,
    "created_by_id" UUID NOT NULL,
    "approved_by_id" UUID,
    "approved_at" TIMESTAMPTZ(3),
    "cancel_reason" TEXT,
    "cancelled_at" TIMESTAMPTZ(3),
    "cancelled_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "expenses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "credit_notes_number_key" ON "credit_notes"("number");

-- CreateIndex
CREATE UNIQUE INDEX "credit_notes_journal_entry_id_key" ON "credit_notes"("journal_entry_id");

-- CreateIndex
CREATE INDEX "credit_notes_branch_id_status_idx" ON "credit_notes"("branch_id", "status");

-- CreateIndex
CREATE INDEX "credit_notes_invoice_id_idx" ON "credit_notes"("invoice_id");

-- CreateIndex
CREATE UNIQUE INDEX "suppliers_number_key" ON "suppliers"("number");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_bills_number_key" ON "supplier_bills"("number");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_bills_journal_entry_id_key" ON "supplier_bills"("journal_entry_id");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_bills_cancel_journal_entry_id_key" ON "supplier_bills"("cancel_journal_entry_id");

-- CreateIndex
CREATE INDEX "supplier_bills_branch_id_status_idx" ON "supplier_bills"("branch_id", "status");

-- CreateIndex
CREATE INDEX "supplier_bills_supplier_id_idx" ON "supplier_bills"("supplier_id");

-- CreateIndex
CREATE INDEX "supplier_bill_lines_shipment_id_idx" ON "supplier_bill_lines"("shipment_id");

-- CreateIndex
CREATE INDEX "supplier_bill_lines_trip_id_idx" ON "supplier_bill_lines"("trip_id");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_bill_lines_bill_id_line_no_key" ON "supplier_bill_lines"("bill_id", "line_no");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_payments_number_key" ON "supplier_payments"("number");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_payments_journal_entry_id_key" ON "supplier_payments"("journal_entry_id");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_payments_cancel_journal_entry_id_key" ON "supplier_payments"("cancel_journal_entry_id");

-- CreateIndex
CREATE INDEX "supplier_payments_branch_id_payment_date_idx" ON "supplier_payments"("branch_id", "payment_date");

-- CreateIndex
CREATE INDEX "supplier_payments_supplier_id_idx" ON "supplier_payments"("supplier_id");

-- CreateIndex
CREATE INDEX "supplier_payment_allocations_bill_id_idx" ON "supplier_payment_allocations"("bill_id");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_payment_allocations_payment_id_bill_id_key" ON "supplier_payment_allocations"("payment_id", "bill_id");

-- CreateIndex
CREATE UNIQUE INDEX "expenses_number_key" ON "expenses"("number");

-- CreateIndex
CREATE UNIQUE INDEX "expenses_journal_entry_id_key" ON "expenses"("journal_entry_id");

-- CreateIndex
CREATE UNIQUE INDEX "expenses_cancel_journal_entry_id_key" ON "expenses"("cancel_journal_entry_id");

-- CreateIndex
CREATE INDEX "expenses_branch_id_expense_date_idx" ON "expenses"("branch_id", "expense_date");

-- CreateIndex
CREATE INDEX "journal_lines_supplier_id_idx" ON "journal_lines"("supplier_id");

-- CreateIndex
CREATE INDEX "journal_lines_trip_id_idx" ON "journal_lines"("trip_id");

-- AddForeignKey
ALTER TABLE "charge_type_postings" ADD CONSTRAINT "charge_type_postings_cost_account_id_fkey" FOREIGN KEY ("cost_account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "trips"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "carriers" ADD CONSTRAINT "carriers_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trips" ADD CONSTRAINT "trips_carrier_bill_id_fkey" FOREIGN KEY ("carrier_bill_id") REFERENCES "supplier_bills"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "customer_invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_journal_entry_id_fkey" FOREIGN KEY ("journal_entry_id") REFERENCES "journal_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_approved_by_id_fkey" FOREIGN KEY ("approved_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_bills" ADD CONSTRAINT "supplier_bills_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_bills" ADD CONSTRAINT "supplier_bills_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_bills" ADD CONSTRAINT "supplier_bills_currency_fkey" FOREIGN KEY ("currency") REFERENCES "currencies"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_bills" ADD CONSTRAINT "supplier_bills_journal_entry_id_fkey" FOREIGN KEY ("journal_entry_id") REFERENCES "journal_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_bills" ADD CONSTRAINT "supplier_bills_cancel_journal_entry_id_fkey" FOREIGN KEY ("cancel_journal_entry_id") REFERENCES "journal_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_bills" ADD CONSTRAINT "supplier_bills_payable_account_id_fkey" FOREIGN KEY ("payable_account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_bills" ADD CONSTRAINT "supplier_bills_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_bills" ADD CONSTRAINT "supplier_bills_approved_by_id_fkey" FOREIGN KEY ("approved_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_bills" ADD CONSTRAINT "supplier_bills_cancelled_by_id_fkey" FOREIGN KEY ("cancelled_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_bill_lines" ADD CONSTRAINT "supplier_bill_lines_bill_id_fkey" FOREIGN KEY ("bill_id") REFERENCES "supplier_bills"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_bill_lines" ADD CONSTRAINT "supplier_bill_lines_charge_type_code_fkey" FOREIGN KEY ("charge_type_code") REFERENCES "charge_types"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_bill_lines" ADD CONSTRAINT "supplier_bill_lines_shipment_id_fkey" FOREIGN KEY ("shipment_id") REFERENCES "shipments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_bill_lines" ADD CONSTRAINT "supplier_bill_lines_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "trips"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_bill_lines" ADD CONSTRAINT "supplier_bill_lines_expense_category_code_fkey" FOREIGN KEY ("expense_category_code") REFERENCES "expense_categories"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_currency_fkey" FOREIGN KEY ("currency") REFERENCES "currencies"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_cash_account_id_fkey" FOREIGN KEY ("cash_account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_journal_entry_id_fkey" FOREIGN KEY ("journal_entry_id") REFERENCES "journal_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_cancel_journal_entry_id_fkey" FOREIGN KEY ("cancel_journal_entry_id") REFERENCES "journal_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_cancelled_by_id_fkey" FOREIGN KEY ("cancelled_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_payment_allocations" ADD CONSTRAINT "supplier_payment_allocations_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "supplier_payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_payment_allocations" ADD CONSTRAINT "supplier_payment_allocations_bill_id_fkey" FOREIGN KEY ("bill_id") REFERENCES "supplier_bills"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expense_categories" ADD CONSTRAINT "expense_categories_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_category_code_fkey" FOREIGN KEY ("category_code") REFERENCES "expense_categories"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_currency_fkey" FOREIGN KEY ("currency") REFERENCES "currencies"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_cash_account_id_fkey" FOREIGN KEY ("cash_account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_journal_entry_id_fkey" FOREIGN KEY ("journal_entry_id") REFERENCES "journal_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_cancel_journal_entry_id_fkey" FOREIGN KEY ("cancel_journal_entry_id") REFERENCES "journal_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_approved_by_id_fkey" FOREIGN KEY ("approved_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_cancelled_by_id_fkey" FOREIGN KEY ("cancelled_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Hand-written (raw SQL; Prisma does not model CHECK constraints). The services check the same
-- rules first and return readable errors; these are the database's last line of defence.
--
-- Locking note for review: the ALTER TABLEs above on existing tables only add nullable columns,
-- columns with constant defaults, foreign keys over all-NULL columns, and drop one NOT NULL, so
-- they are metadata changes plus a quick validation. Replacing the invoice amounts check below
-- re-validates customer_invoices under a short ACCESS EXCLUSIVE lock. Nothing is dropped or renamed.

-- Customer invoices: credit notes count with payments against the total; an opening item
-- (rule 15) is approved when recorded and has no shipment, every other invoice has one.
ALTER TABLE "customer_invoices" DROP CONSTRAINT "customer_invoices_amounts_check";
ALTER TABLE "customer_invoices" ADD CONSTRAINT "customer_invoices_amounts_check" CHECK (
    "total" >= 0 AND "total_usd" >= 0 AND "paid_amount" >= 0 AND "paid_usd" >= 0
    AND "credited_amount" >= 0 AND "credited_usd" >= 0
    AND "paid_amount" + "credited_amount" <= "total"
    AND "paid_usd" + "credited_usd" <= "total_usd");
ALTER TABLE "customer_invoices" ADD CONSTRAINT "customer_invoices_opening_check" CHECK (
    ("is_opening" AND "status" = 'APPROVED' AND "shipment_id" IS NULL)
    OR (NOT "is_opening" AND "shipment_id" IS NOT NULL));

-- Credit notes (rule 6): a draft has no number and no entry; an approved one has both and the
-- USD value it cleared; only drafts are cancelled.
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_amount_check" CHECK (
    "amount" > 0 AND ("amount_usd" IS NULL OR "amount_usd" >= 0) AND btrim("reason") <> '');
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_status_check" CHECK (
    ("status" = 'APPROVED') = ("number" IS NOT NULL AND "journal_entry_id" IS NOT NULL
        AND "amount_usd" IS NOT NULL AND "approved_at" IS NOT NULL AND "approved_by_id" IS NOT NULL)
    AND ("status" = 'APPROVED' OR ("number" IS NULL AND "journal_entry_id" IS NULL AND "amount_usd" IS NULL))
    AND (("status" = 'CANCELLED') = ("cancelled_at" IS NOT NULL AND "cancel_reason" IS NOT NULL)));

-- Suppliers.
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_name_check" CHECK (btrim("name") <> '');
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_terms_check" CHECK ("payment_terms_days" BETWEEN 0 AND 3650);

-- Supplier bills: like customer invoices. An approved bill is cancelled only with its reversing
-- entry (a draft without one); an opening item is never a draft.
ALTER TABLE "supplier_bills" ADD CONSTRAINT "supplier_bills_rate_check" CHECK ("fx_rate" > 0 AND ("currency" <> 'USD' OR "fx_rate" = 1));
ALTER TABLE "supplier_bills" ADD CONSTRAINT "supplier_bills_dates_check" CHECK ("due_date" >= "bill_date");
ALTER TABLE "supplier_bills" ADD CONSTRAINT "supplier_bills_amounts_check" CHECK (
    "total" >= 0 AND "total_usd" >= 0 AND "paid_amount" >= 0 AND "paid_amount" <= "total"
    AND "paid_usd" >= 0 AND "paid_usd" <= "total_usd");
ALTER TABLE "supplier_bills" ADD CONSTRAINT "supplier_bills_status_check" CHECK (
    ("status" <> 'DRAFT' OR ("number" IS NULL AND "journal_entry_id" IS NULL AND "payable_account_id" IS NULL
        AND "approved_at" IS NULL AND NOT "is_opening"))
    AND ("status" <> 'APPROVED' OR ("number" IS NOT NULL AND "journal_entry_id" IS NOT NULL
        AND "payable_account_id" IS NOT NULL AND "approved_at" IS NOT NULL AND "approved_by_id" IS NOT NULL))
    AND (("status" = 'CANCELLED') = ("cancelled_at" IS NOT NULL AND "cancel_reason" IS NOT NULL AND "cancelled_by_id" IS NOT NULL))
    AND (("cancel_journal_entry_id" IS NOT NULL) = ("status" = 'CANCELLED' AND "journal_entry_id" IS NOT NULL)));

-- Bill lines: each kind carries exactly its own references.
ALTER TABLE "supplier_bill_lines" ADD CONSTRAINT "supplier_bill_lines_amount_check" CHECK ("amount" > 0);
ALTER TABLE "supplier_bill_lines" ADD CONSTRAINT "supplier_bill_lines_kind_check" CHECK (
    ("kind" = 'SHIPMENT_COST' AND "charge_type_code" IS NOT NULL AND "shipment_id" IS NOT NULL
        AND "trip_id" IS NULL AND "expense_category_code" IS NULL)
    OR ("kind" = 'TRIP' AND "trip_id" IS NOT NULL AND "charge_type_code" IS NULL
        AND "shipment_id" IS NULL AND "expense_category_code" IS NULL)
    OR ("kind" = 'EXPENSE' AND "expense_category_code" IS NOT NULL AND "charge_type_code" IS NULL
        AND "shipment_id" IS NULL AND "trip_id" IS NULL));

-- A trip's carrier bill clears an accrual, so only an accrued trip has one.
ALTER TABLE "trips" ADD CONSTRAINT "trips_carrier_bill_check" CHECK ("carrier_bill_id" IS NULL OR "accrual_entry_id" IS NOT NULL);

-- Supplier payments.
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_amount_check" CHECK (
    "amount" > 0 AND "fx_rate" > 0 AND ("currency" <> 'USD' OR "fx_rate" = 1));
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_cancel_check" CHECK (
    ("status" = 'CANCELLED') = ("cancelled_at" IS NOT NULL AND "cancelled_by_id" IS NOT NULL
        AND "cancel_journal_entry_id" IS NOT NULL AND "cancel_reason" IS NOT NULL));
ALTER TABLE "supplier_payment_allocations" ADD CONSTRAINT "supplier_payment_allocations_amount_check" CHECK ("amount" > 0 AND "relieved_usd" >= 0);

-- Expense categories and general expenses (rule 12).
ALTER TABLE "expense_categories" ADD CONSTRAINT "expense_categories_code_check" CHECK ("code" ~ '^[A-Z0-9_]{1,20}$');
ALTER TABLE "expense_categories" ADD CONSTRAINT "expense_categories_name_check" CHECK (btrim("name_en") <> '' AND btrim("name_ar") <> '');
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_amount_check" CHECK (
    "amount" > 0 AND "fx_rate" > 0 AND ("currency" <> 'USD' OR "fx_rate" = 1) AND btrim("description") <> '');
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_status_check" CHECK (
    ("status" <> 'DRAFT' OR ("number" IS NULL AND "journal_entry_id" IS NULL AND "approved_at" IS NULL))
    AND ("status" <> 'APPROVED' OR ("number" IS NOT NULL AND "journal_entry_id" IS NOT NULL
        AND "approved_at" IS NOT NULL AND "approved_by_id" IS NOT NULL))
    AND (("status" = 'CANCELLED') = ("cancelled_at" IS NOT NULL AND "cancel_reason" IS NOT NULL AND "cancelled_by_id" IS NOT NULL))
    AND (("cancel_journal_entry_id" IS NOT NULL) = ("status" = 'CANCELLED' AND "journal_entry_id" IS NOT NULL)));

-- Hand-written: starting expense categories, all on the general expenses account. NOLON's
-- accountant adds categories and points them at other expense accounts from the settings.
INSERT INTO "expense_categories" ("code", "name_en", "name_ar", "account_id", "updated_at")
SELECT c."code", c."name_en", c."name_ar", a."id", CURRENT_TIMESTAMP
FROM (VALUES
    ('GENERAL', 'General expenses', 'مصروفات عامة'),
    ('RENT', 'Rent', 'إيجارات'),
    ('UTILITIES', 'Utilities', 'كهرباء ومياه واتصالات'),
    ('OFFICE', 'Office supplies', 'أدوات مكتبية')
) AS c("code", "name_en", "name_ar")
JOIN "accounts" a ON a."code" = '6100';

-- Supplier bills post shipment costs by charge type (rule 7): the transport charges to transport
-- cost, the customs charge to clearance cost, storage to storage cost. Others use DEFAULT_COST.
UPDATE "charge_type_postings" p SET "cost_account_id" = a."id", "updated_at" = CURRENT_TIMESTAMP
FROM (VALUES
    ('CUSTOMS', '5200'),
    ('PICKUP', '5300'),
    ('INLAND', '5300'),
    ('DELIVERY', '5300'),
    ('STORAGE', '5400')
) AS m("charge", "code")
JOIN "accounts" a ON a."code" = m."code"
WHERE p."charge_type_code" = m."charge";
