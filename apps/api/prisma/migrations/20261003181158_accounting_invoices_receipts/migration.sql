-- CreateEnum
CREATE TYPE "account_type" AS ENUM ('ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE');

-- CreateEnum
CREATE TYPE "posting_role" AS ENUM ('RECEIVABLE', 'PAYABLE', 'CUSTOMER_ADVANCES', 'DEFAULT_REVENUE', 'DEFAULT_COST', 'REIMBURSABLE', 'CONSOLIDATION_CLEARING', 'ACCRUED_TRANSPORT', 'FX_GAIN', 'FX_LOSS', 'ROUNDING', 'OPENING_EQUITY');

-- CreateEnum
CREATE TYPE "period_status" AS ENUM ('OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "journal_status" AS ENUM ('DRAFT', 'POSTED');

-- CreateEnum
CREATE TYPE "journal_source" AS ENUM ('MANUAL', 'CUSTOMER_INVOICE', 'RECEIPT', 'REVERSAL');

-- CreateEnum
CREATE TYPE "invoice_status" AS ENUM ('DRAFT', 'APPROVED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "receipt_status" AS ENUM ('POSTED', 'CANCELLED');

-- CreateTable
CREATE TABLE "accounts" (
    "id" UUID NOT NULL,
    "code" VARCHAR(20) NOT NULL,
    "name_en" VARCHAR(200) NOT NULL,
    "name_ar" VARCHAR(200) NOT NULL,
    "type" "account_type" NOT NULL,
    "parent_id" UUID,
    "is_postable" BOOLEAN NOT NULL DEFAULT true,
    "is_cash" BOOLEAN NOT NULL DEFAULT false,
    "currency" CHAR(3),
    "branch_id" UUID,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account_mappings" (
    "role" "posting_role" NOT NULL,
    "account_id" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "account_mappings_pkey" PRIMARY KEY ("role")
);

-- CreateTable
CREATE TABLE "charge_type_postings" (
    "charge_type_code" VARCHAR(20) NOT NULL,
    "revenue_account_id" UUID,
    "is_reimbursable" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "charge_type_postings_pkey" PRIMARY KEY ("charge_type_code")
);

-- CreateTable
CREATE TABLE "fiscal_periods" (
    "id" UUID NOT NULL,
    "year" SMALLINT NOT NULL,
    "month" SMALLINT NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE NOT NULL,
    "status" "period_status" NOT NULL DEFAULT 'OPEN',
    "closed_at" TIMESTAMPTZ(3),
    "closed_by_id" UUID,

    CONSTRAINT "fiscal_periods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fx_rates" (
    "id" UUID NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "rate_date" DATE NOT NULL,
    "rate" DECIMAL(18,8) NOT NULL,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "fx_rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "journal_entries" (
    "id" UUID NOT NULL,
    "number" VARCHAR(30) NOT NULL,
    "branch_id" UUID NOT NULL,
    "entry_date" DATE NOT NULL,
    "period_id" UUID NOT NULL,
    "description" TEXT NOT NULL,
    "source" "journal_source" NOT NULL,
    "source_id" UUID,
    "status" "journal_status" NOT NULL DEFAULT 'DRAFT',
    "reversal_of_id" UUID,
    "created_by_id" UUID NOT NULL,
    "posted_by_id" UUID,
    "posted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "journal_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "journal_lines" (
    "id" UUID NOT NULL,
    "entry_id" UUID NOT NULL,
    "line_no" SMALLINT NOT NULL,
    "account_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "shipment_id" UUID,
    "customer_id" UUID,
    "description" TEXT,
    "currency" CHAR(3) NOT NULL,
    "fx_rate" DECIMAL(18,8) NOT NULL,
    "debit" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "credit" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "debit_usd" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "credit_usd" DECIMAL(18,4) NOT NULL DEFAULT 0,

    CONSTRAINT "journal_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_invoices" (
    "id" UUID NOT NULL,
    "number" VARCHAR(30),
    "branch_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "shipment_id" UUID NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "fx_rate" DECIMAL(18,8) NOT NULL,
    "invoice_date" DATE NOT NULL,
    "due_date" DATE NOT NULL,
    "status" "invoice_status" NOT NULL DEFAULT 'DRAFT',
    "total" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "total_usd" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "paid_amount" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "paid_usd" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "notes" TEXT,
    "journal_entry_id" UUID,
    "created_by_id" UUID NOT NULL,
    "approved_by_id" UUID,
    "approved_at" TIMESTAMPTZ(3),
    "cancel_reason" TEXT,
    "cancelled_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "customer_invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_invoice_lines" (
    "id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "line_no" SMALLINT NOT NULL,
    "charge_type_code" VARCHAR(20) NOT NULL,
    "description" TEXT,
    "quantity" DECIMAL(18,4) NOT NULL,
    "unit_price" DECIMAL(18,4) NOT NULL,
    "line_total" DECIMAL(18,4) NOT NULL,

    CONSTRAINT "customer_invoice_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "receipts" (
    "id" UUID NOT NULL,
    "number" VARCHAR(30) NOT NULL,
    "branch_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "receipt_date" DATE NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "fx_rate" DECIMAL(18,8) NOT NULL,
    "amount" DECIMAL(18,4) NOT NULL,
    "cash_account_id" UUID NOT NULL,
    "reference" VARCHAR(100),
    "notes" TEXT,
    "status" "receipt_status" NOT NULL DEFAULT 'POSTED',
    "journal_entry_id" UUID NOT NULL,
    "cancel_journal_entry_id" UUID,
    "cancel_reason" TEXT,
    "cancelled_at" TIMESTAMPTZ(3),
    "cancelled_by_id" UUID,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "receipt_allocations" (
    "id" UUID NOT NULL,
    "receipt_id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "amount" DECIMAL(18,4) NOT NULL,
    "relieved_usd" DECIMAL(18,4) NOT NULL,

    CONSTRAINT "receipt_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "accounts_code_key" ON "accounts"("code");

-- CreateIndex
CREATE UNIQUE INDEX "fiscal_periods_year_month_key" ON "fiscal_periods"("year", "month");

-- CreateIndex
CREATE UNIQUE INDEX "fx_rates_currency_rate_date_key" ON "fx_rates"("currency", "rate_date");

-- CreateIndex
CREATE UNIQUE INDEX "journal_entries_number_key" ON "journal_entries"("number");

-- CreateIndex
CREATE UNIQUE INDEX "journal_entries_reversal_of_id_key" ON "journal_entries"("reversal_of_id");

-- CreateIndex
CREATE INDEX "journal_entries_branch_id_entry_date_idx" ON "journal_entries"("branch_id", "entry_date");

-- CreateIndex
CREATE INDEX "journal_entries_source_source_id_idx" ON "journal_entries"("source", "source_id");

-- CreateIndex
CREATE INDEX "journal_lines_account_id_idx" ON "journal_lines"("account_id");

-- CreateIndex
CREATE INDEX "journal_lines_customer_id_idx" ON "journal_lines"("customer_id");

-- CreateIndex
CREATE INDEX "journal_lines_shipment_id_idx" ON "journal_lines"("shipment_id");

-- CreateIndex
CREATE UNIQUE INDEX "journal_lines_entry_id_line_no_key" ON "journal_lines"("entry_id", "line_no");

-- CreateIndex
CREATE UNIQUE INDEX "customer_invoices_number_key" ON "customer_invoices"("number");

-- CreateIndex
CREATE UNIQUE INDEX "customer_invoices_journal_entry_id_key" ON "customer_invoices"("journal_entry_id");

-- CreateIndex
CREATE INDEX "customer_invoices_branch_id_status_idx" ON "customer_invoices"("branch_id", "status");

-- CreateIndex
CREATE INDEX "customer_invoices_customer_id_idx" ON "customer_invoices"("customer_id");

-- CreateIndex
CREATE INDEX "customer_invoices_shipment_id_idx" ON "customer_invoices"("shipment_id");

-- CreateIndex
CREATE UNIQUE INDEX "customer_invoice_lines_invoice_id_line_no_key" ON "customer_invoice_lines"("invoice_id", "line_no");

-- CreateIndex
CREATE UNIQUE INDEX "receipts_number_key" ON "receipts"("number");

-- CreateIndex
CREATE UNIQUE INDEX "receipts_journal_entry_id_key" ON "receipts"("journal_entry_id");

-- CreateIndex
CREATE UNIQUE INDEX "receipts_cancel_journal_entry_id_key" ON "receipts"("cancel_journal_entry_id");

-- CreateIndex
CREATE INDEX "receipts_branch_id_receipt_date_idx" ON "receipts"("branch_id", "receipt_date");

-- CreateIndex
CREATE INDEX "receipts_customer_id_idx" ON "receipts"("customer_id");

-- CreateIndex
CREATE INDEX "receipt_allocations_invoice_id_idx" ON "receipt_allocations"("invoice_id");

-- CreateIndex
CREATE UNIQUE INDEX "receipt_allocations_receipt_id_invoice_id_key" ON "receipt_allocations"("receipt_id", "invoice_id");

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_currency_fkey" FOREIGN KEY ("currency") REFERENCES "currencies"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_mappings" ADD CONSTRAINT "account_mappings_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "charge_type_postings" ADD CONSTRAINT "charge_type_postings_charge_type_code_fkey" FOREIGN KEY ("charge_type_code") REFERENCES "charge_types"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "charge_type_postings" ADD CONSTRAINT "charge_type_postings_revenue_account_id_fkey" FOREIGN KEY ("revenue_account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fiscal_periods" ADD CONSTRAINT "fiscal_periods_closed_by_id_fkey" FOREIGN KEY ("closed_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fx_rates" ADD CONSTRAINT "fx_rates_currency_fkey" FOREIGN KEY ("currency") REFERENCES "currencies"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fx_rates" ADD CONSTRAINT "fx_rates_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_period_id_fkey" FOREIGN KEY ("period_id") REFERENCES "fiscal_periods"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_reversal_of_id_fkey" FOREIGN KEY ("reversal_of_id") REFERENCES "journal_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_posted_by_id_fkey" FOREIGN KEY ("posted_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_entry_id_fkey" FOREIGN KEY ("entry_id") REFERENCES "journal_entries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_shipment_id_fkey" FOREIGN KEY ("shipment_id") REFERENCES "shipments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_currency_fkey" FOREIGN KEY ("currency") REFERENCES "currencies"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_invoices" ADD CONSTRAINT "customer_invoices_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_invoices" ADD CONSTRAINT "customer_invoices_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_invoices" ADD CONSTRAINT "customer_invoices_shipment_id_fkey" FOREIGN KEY ("shipment_id") REFERENCES "shipments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_invoices" ADD CONSTRAINT "customer_invoices_currency_fkey" FOREIGN KEY ("currency") REFERENCES "currencies"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_invoices" ADD CONSTRAINT "customer_invoices_journal_entry_id_fkey" FOREIGN KEY ("journal_entry_id") REFERENCES "journal_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_invoices" ADD CONSTRAINT "customer_invoices_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_invoices" ADD CONSTRAINT "customer_invoices_approved_by_id_fkey" FOREIGN KEY ("approved_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_invoice_lines" ADD CONSTRAINT "customer_invoice_lines_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "customer_invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_invoice_lines" ADD CONSTRAINT "customer_invoice_lines_charge_type_code_fkey" FOREIGN KEY ("charge_type_code") REFERENCES "charge_types"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_currency_fkey" FOREIGN KEY ("currency") REFERENCES "currencies"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_cash_account_id_fkey" FOREIGN KEY ("cash_account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_journal_entry_id_fkey" FOREIGN KEY ("journal_entry_id") REFERENCES "journal_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_cancel_journal_entry_id_fkey" FOREIGN KEY ("cancel_journal_entry_id") REFERENCES "journal_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_cancelled_by_id_fkey" FOREIGN KEY ("cancelled_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipt_allocations" ADD CONSTRAINT "receipt_allocations_receipt_id_fkey" FOREIGN KEY ("receipt_id") REFERENCES "receipts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipt_allocations" ADD CONSTRAINT "receipt_allocations_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "customer_invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Raw SQL (not expressible in schema.prisma): data rules the database enforces as a last line of
-- defence. The services check the same rules first and return readable errors.
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_code_check" CHECK ("code" ~ '^[0-9A-Z][0-9A-Z.-]{0,19}$');
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_parent_check" CHECK ("parent_id" IS NULL OR "parent_id" <> "id");
-- A cash or bank account is postable and holds exactly one currency; other accounts have no
-- currency and no branch of their own (the branch is a dimension on each journal line).
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_cash_check" CHECK (
    ("is_cash" AND "is_postable" AND "currency" IS NOT NULL)
    OR (NOT "is_cash" AND "currency" IS NULL AND "branch_id" IS NULL));
ALTER TABLE "fiscal_periods" ADD CONSTRAINT "fiscal_periods_month_check" CHECK ("month" BETWEEN 1 AND 12 AND "start_date" <= "end_date");
ALTER TABLE "fiscal_periods" ADD CONSTRAINT "fiscal_periods_closed_check" CHECK (("status" = 'CLOSED') = ("closed_at" IS NOT NULL));
ALTER TABLE "fx_rates" ADD CONSTRAINT "fx_rates_rate_check" CHECK ("rate" > 0 AND "currency" <> 'USD');
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_description_check" CHECK (btrim("description") <> '');
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_posted_check" CHECK (
    ("status" = 'POSTED') = ("posted_at" IS NOT NULL) AND ("posted_at" IS NULL) = ("posted_by_id" IS NULL));
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_reversal_check" CHECK (
    ("source" = 'REVERSAL') = ("reversal_of_id" IS NOT NULL) AND ("reversal_of_id" IS NULL OR "reversal_of_id" <> "id"));
-- Each line is a debit or a credit, never both and never neither. USD is the reporting currency:
-- a USD line has rate 1 and the same amount in both columns.
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_side_check" CHECK (
    "debit" >= 0 AND "credit" >= 0 AND "debit_usd" >= 0 AND "credit_usd" >= 0
    AND (("debit" > 0 AND "credit" = 0 AND "credit_usd" = 0) OR ("credit" > 0 AND "debit" = 0 AND "debit_usd" = 0)));
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_rate_check" CHECK (
    "fx_rate" > 0 AND ("currency" <> 'USD' OR ("fx_rate" = 1 AND "debit_usd" = "debit" AND "credit_usd" = "credit")));
ALTER TABLE "customer_invoices" ADD CONSTRAINT "customer_invoices_rate_check" CHECK ("fx_rate" > 0 AND ("currency" <> 'USD' OR "fx_rate" = 1));
ALTER TABLE "customer_invoices" ADD CONSTRAINT "customer_invoices_dates_check" CHECK ("due_date" >= "invoice_date");
ALTER TABLE "customer_invoices" ADD CONSTRAINT "customer_invoices_amounts_check" CHECK (
    "total" >= 0 AND "total_usd" >= 0 AND "paid_amount" >= 0 AND "paid_amount" <= "total"
    AND "paid_usd" >= 0 AND "paid_usd" <= "total_usd");
-- A draft has no number and no entry; an approved invoice has both. Numbers are given on approval,
-- so approved invoices are numbered without gaps.
ALTER TABLE "customer_invoices" ADD CONSTRAINT "customer_invoices_status_check" CHECK (
    ("status" <> 'DRAFT' OR ("number" IS NULL AND "journal_entry_id" IS NULL AND "approved_at" IS NULL))
    AND ("status" <> 'APPROVED' OR ("number" IS NOT NULL AND "journal_entry_id" IS NOT NULL AND "approved_at" IS NOT NULL AND "approved_by_id" IS NOT NULL))
    AND (("status" = 'CANCELLED') = ("cancelled_at" IS NOT NULL AND "cancel_reason" IS NOT NULL)));
ALTER TABLE "customer_invoice_lines" ADD CONSTRAINT "customer_invoice_lines_amounts_check" CHECK (
    "quantity" > 0 AND "unit_price" >= 0 AND "line_total" >= 0);
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_amount_check" CHECK (
    "amount" > 0 AND "fx_rate" > 0 AND ("currency" <> 'USD' OR "fx_rate" = 1));
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_cancel_check" CHECK (
    ("status" = 'CANCELLED') = ("cancelled_at" IS NOT NULL AND "cancelled_by_id" IS NOT NULL
        AND "cancel_journal_entry_id" IS NOT NULL AND "cancel_reason" IS NOT NULL));
ALTER TABLE "receipt_allocations" ADD CONSTRAINT "receipt_allocations_amount_check" CHECK ("amount" > 0 AND "relieved_usd" >= 0);

-- Hand-written: posted journal entries are immutable (AGENTS.md rule 3).
--
-- An entry is created as a DRAFT, its lines are written, and it is posted by one UPDATE to
-- POSTED. Posting is accepted only when the entry has at least two lines, balances in USD, posts
-- to postable accounts only, and falls inside its period, which must be open. After that, no
-- UPDATE or DELETE of the entry or its lines is accepted, and the tables cannot be truncated.
-- Corrections are reversing entries (reversal_of_id).
--
-- Locks: the line trigger takes a share lock on its entry and the posting check a share lock on
-- the period, so a line written or a period closed concurrently cannot slip past the checks.
CREATE FUNCTION "journal_entries_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    v_period RECORD;
    v_lines integer;
    v_debit numeric;
    v_credit numeric;
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW."status" <> 'DRAFT' THEN
            RAISE EXCEPTION 'Journal entry % must be created as a draft and then posted', NEW."number";
        END IF;
        RETURN NEW;
    END IF;

    IF OLD."status" = 'POSTED' THEN
        RAISE EXCEPTION 'Journal entry % is posted and cannot be changed or deleted; post a reversing entry', OLD."number";
    END IF;

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;

    IF NEW."status" = 'POSTED' THEN
        SELECT "status", "start_date", "end_date" INTO v_period
            FROM "fiscal_periods" WHERE "id" = NEW."period_id" FOR SHARE;
        IF v_period."status" IS DISTINCT FROM 'OPEN' THEN
            RAISE EXCEPTION 'Journal entry % cannot be posted: its period is closed', NEW."number";
        END IF;
        IF NEW."entry_date" < v_period."start_date" OR NEW."entry_date" > v_period."end_date" THEN
            RAISE EXCEPTION 'Journal entry % is dated outside its period', NEW."number";
        END IF;
        SELECT count(*), coalesce(sum("debit_usd"), 0), coalesce(sum("credit_usd"), 0)
            INTO v_lines, v_debit, v_credit
            FROM "journal_lines" WHERE "entry_id" = NEW."id";
        IF v_lines < 2 OR v_debit <> v_credit OR v_debit = 0 THEN
            RAISE EXCEPTION 'Journal entry % is unbalanced (debit % USD, credit % USD)', NEW."number", v_debit, v_credit;
        END IF;
        IF EXISTS (
            SELECT 1 FROM "journal_lines" l JOIN "accounts" a ON a."id" = l."account_id"
            WHERE l."entry_id" = NEW."id" AND NOT a."is_postable"
        ) THEN
            RAISE EXCEPTION 'Journal entry % posts to a header account', NEW."number";
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "journal_entries_guard"
    BEFORE INSERT OR UPDATE OR DELETE ON "journal_entries"
    FOR EACH ROW EXECUTE FUNCTION "journal_entries_guard"();

CREATE FUNCTION "journal_lines_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    v_status "journal_status";
BEGIN
    IF TG_OP IN ('UPDATE', 'DELETE') THEN
        SELECT "status" INTO v_status FROM "journal_entries" WHERE "id" = OLD."entry_id" FOR SHARE;
        IF v_status = 'POSTED' THEN
            RAISE EXCEPTION 'Lines of a posted journal entry cannot be changed or deleted';
        END IF;
    END IF;
    IF TG_OP IN ('INSERT', 'UPDATE') THEN
        SELECT "status" INTO v_status FROM "journal_entries" WHERE "id" = NEW."entry_id" FOR SHARE;
        IF v_status = 'POSTED' THEN
            RAISE EXCEPTION 'Lines cannot be added to a posted journal entry';
        END IF;
        RETURN NEW;
    END IF;
    RETURN OLD;
END;
$$;

CREATE TRIGGER "journal_lines_guard"
    BEFORE INSERT OR UPDATE OR DELETE ON "journal_lines"
    FOR EACH ROW EXECUTE FUNCTION "journal_lines_guard"();

-- TRUNCATE skips row triggers, so it is refused outright on both tables.
CREATE FUNCTION "journal_truncate_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'Journal tables cannot be truncated';
END;
$$;

CREATE TRIGGER "journal_entries_no_truncate"
    BEFORE TRUNCATE ON "journal_entries"
    FOR EACH STATEMENT EXECUTE FUNCTION "journal_truncate_guard"();
CREATE TRIGGER "journal_lines_no_truncate"
    BEFORE TRUNCATE ON "journal_lines"
    FOR EACH STATEMENT EXECUTE FUNCTION "journal_truncate_guard"();

-- Hand-written: a starting chart of accounts and the posting roles of annex C section 4. Generic
-- names; NOLON's accountant renames, adds and remaps from the settings without code changes.
-- Cash and bank accounts are added per branch and currency in the settings.
INSERT INTO "accounts" ("id", "code", "name_en", "name_ar", "type", "is_postable", "updated_at") VALUES
    (gen_random_uuid(), '1000', 'Assets', 'الأصول', 'ASSET', false, CURRENT_TIMESTAMP),
    (gen_random_uuid(), '1100', 'Cash and banks', 'النقدية والبنوك', 'ASSET', false, CURRENT_TIMESTAMP),
    (gen_random_uuid(), '1200', 'Accounts receivable', 'الذمم المدينة', 'ASSET', true, CURRENT_TIMESTAMP),
    (gen_random_uuid(), '1300', 'Reimbursable expenses (clearing)', 'مصاريف مستردة (وسيط)', 'ASSET', true, CURRENT_TIMESTAMP),
    (gen_random_uuid(), '1400', 'Consolidated container cost (clearing)', 'تكلفة الحاوية المجمّعة (وسيط)', 'ASSET', true, CURRENT_TIMESTAMP),
    (gen_random_uuid(), '2000', 'Liabilities', 'الالتزامات', 'LIABILITY', false, CURRENT_TIMESTAMP),
    (gen_random_uuid(), '2100', 'Accounts payable', 'الذمم الدائنة', 'LIABILITY', true, CURRENT_TIMESTAMP),
    (gen_random_uuid(), '2200', 'Customer advances', 'دفعات مقدمة من العملاء', 'LIABILITY', true, CURRENT_TIMESTAMP),
    (gen_random_uuid(), '2300', 'Accrued transport costs (clearing)', 'تكاليف نقل مستحقة (وسيط)', 'LIABILITY', true, CURRENT_TIMESTAMP),
    (gen_random_uuid(), '3000', 'Equity', 'حقوق الملكية', 'EQUITY', false, CURRENT_TIMESTAMP),
    (gen_random_uuid(), '3100', 'Opening balance equity', 'حقوق ملكية افتتاحية', 'EQUITY', true, CURRENT_TIMESTAMP),
    (gen_random_uuid(), '3200', 'Retained earnings', 'الأرباح المحتجزة', 'EQUITY', true, CURRENT_TIMESTAMP),
    (gen_random_uuid(), '4000', 'Revenue', 'الإيرادات', 'REVENUE', false, CURRENT_TIMESTAMP),
    (gen_random_uuid(), '4100', 'Freight revenue', 'إيرادات الشحن', 'REVENUE', true, CURRENT_TIMESTAMP),
    (gen_random_uuid(), '4200', 'Customs clearance revenue', 'إيرادات التخليص', 'REVENUE', true, CURRENT_TIMESTAMP),
    (gen_random_uuid(), '4300', 'Transport revenue', 'إيرادات النقل', 'REVENUE', true, CURRENT_TIMESTAMP),
    (gen_random_uuid(), '4400', 'Storage revenue', 'إيرادات التخزين', 'REVENUE', true, CURRENT_TIMESTAMP),
    (gen_random_uuid(), '4900', 'Realized exchange gains', 'أرباح فروقات عملة محققة', 'REVENUE', true, CURRENT_TIMESTAMP),
    (gen_random_uuid(), '5000', 'Cost of shipments', 'تكلفة الشحنات', 'EXPENSE', false, CURRENT_TIMESTAMP),
    (gen_random_uuid(), '5100', 'Freight cost', 'تكلفة الشحن', 'EXPENSE', true, CURRENT_TIMESTAMP),
    (gen_random_uuid(), '5200', 'Customs clearance cost', 'تكلفة التخليص', 'EXPENSE', true, CURRENT_TIMESTAMP),
    (gen_random_uuid(), '5300', 'Transport cost', 'تكلفة النقل', 'EXPENSE', true, CURRENT_TIMESTAMP),
    (gen_random_uuid(), '5400', 'Storage cost', 'تكلفة التخزين', 'EXPENSE', true, CURRENT_TIMESTAMP),
    (gen_random_uuid(), '6000', 'Operating expenses', 'المصروفات', 'EXPENSE', false, CURRENT_TIMESTAMP),
    (gen_random_uuid(), '6100', 'General expenses', 'مصروفات عامة', 'EXPENSE', true, CURRENT_TIMESTAMP),
    (gen_random_uuid(), '6900', 'Realized exchange losses', 'خسائر فروقات عملة محققة', 'EXPENSE', true, CURRENT_TIMESTAMP),
    (gen_random_uuid(), '6950', 'Rounding differences', 'فروقات التقريب', 'EXPENSE', true, CURRENT_TIMESTAMP);

UPDATE "accounts" AS child SET "parent_id" = parent."id"
FROM "accounts" AS parent
WHERE parent."code" = CASE
    WHEN child."code" IN ('1100', '1200', '1300', '1400') THEN '1000'
    WHEN child."code" IN ('2100', '2200', '2300') THEN '2000'
    WHEN child."code" IN ('3100', '3200') THEN '3000'
    WHEN child."code" IN ('4100', '4200', '4300', '4400', '4900') THEN '4000'
    WHEN child."code" IN ('5100', '5200', '5300', '5400') THEN '5000'
    WHEN child."code" IN ('6100', '6900', '6950') THEN '6000'
END;

INSERT INTO "account_mappings" ("role", "account_id", "updated_at")
SELECT m."role"::"posting_role", a."id", CURRENT_TIMESTAMP
FROM (VALUES
    ('RECEIVABLE', '1200'),
    ('PAYABLE', '2100'),
    ('CUSTOMER_ADVANCES', '2200'),
    ('DEFAULT_REVENUE', '4100'),
    ('DEFAULT_COST', '5100'),
    ('REIMBURSABLE', '1300'),
    ('CONSOLIDATION_CLEARING', '1400'),
    ('ACCRUED_TRANSPORT', '2300'),
    ('FX_GAIN', '4900'),
    ('FX_LOSS', '6900'),
    ('ROUNDING', '6950'),
    ('OPENING_EQUITY', '3100')
) AS m("role", "code")
JOIN "accounts" a ON a."code" = m."code";

-- Duties and fees NOLON pays for the customer and charges back at cost (annex C rule 2).
INSERT INTO "charge_types" ("code", "name_en", "name_ar") VALUES
    ('DUTIES', 'Duties paid for the customer', 'رسوم مدفوعة نيابة عن العميل')
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "charge_type_postings" ("charge_type_code", "revenue_account_id", "is_reimbursable", "updated_at")
SELECT p."code", a."id", p."reimbursable", CURRENT_TIMESTAMP
FROM (VALUES
    ('FREIGHT', '4100', false),
    ('THC', '4100', false),
    ('DOCS', '4100', false),
    ('CUSTOMS', '4200', false),
    ('PICKUP', '4300', false),
    ('INLAND', '4300', false),
    ('DELIVERY', '4300', false),
    ('STORAGE', '4400', false),
    ('DUTIES', NULL, true)
) AS p("code", "account_code", "reimbursable")
JOIN "charge_types" c ON c."code" = p."code"
LEFT JOIN "accounts" a ON a."code" = p."account_code";
