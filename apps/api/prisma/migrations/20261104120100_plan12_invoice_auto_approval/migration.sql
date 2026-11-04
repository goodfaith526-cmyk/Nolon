-- Plan 12, section 2.1: how an invoice was approved. customer_invoices is an accounting table, so
-- this migration needs the owner's label (AGENTS.md rule 4). Every existing invoice becomes
-- MANUAL; no amount, entry or posted row changes. The constant default does not rewrite the table
-- (PostgreSQL 16); the CHECK constraints (the status check
-- dropped and added again without its approver clause) scan it under a brief lock.

-- CreateEnum
CREATE TYPE "invoice_approval_source" AS ENUM ('MANUAL', 'AUTO_ON_CONFIRM');

-- CreateEnum
CREATE TYPE "invoice_auto_rule" AS ENUM ('AGREED_PRICE', 'RATE_CARD_WITH_RIGHT');

-- AlterTable
ALTER TABLE "customer_invoices" ADD COLUMN "approval_source" "invoice_approval_source" NOT NULL DEFAULT 'MANUAL',
ADD COLUMN "auto_initiated_by_id" UUID,
ADD COLUMN "auto_note" VARCHAR(40),
ADD COLUMN "auto_rule" "invoice_auto_rule",
ADD COLUMN "auto_terms_hash" CHAR(64);

-- AddForeignKey
ALTER TABLE "customer_invoices" ADD CONSTRAINT "customer_invoices_auto_initiated_by_id_fkey" FOREIGN KEY ("auto_initiated_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The status check keeps every rule it had, except that the approver moves to its own check below.
ALTER TABLE "customer_invoices" DROP CONSTRAINT "customer_invoices_status_check";
ALTER TABLE "customer_invoices" ADD CONSTRAINT "customer_invoices_status_check" CHECK (
    ("status" <> 'DRAFT' OR ("number" IS NULL AND "journal_entry_id" IS NULL AND "receivable_account_id" IS NULL AND "approved_at" IS NULL))
    AND ("status" <> 'APPROVED' OR ("number" IS NOT NULL AND "journal_entry_id" IS NOT NULL AND "receivable_account_id" IS NOT NULL AND "approved_at" IS NOT NULL))
    AND (("status" = 'CANCELLED') = ("cancelled_at" IS NOT NULL AND "cancel_reason" IS NOT NULL)));

-- An approved invoice names the person who approved it, or is an automatic approval naming the
-- person whose confirmation made it, under one of the two rules (an agreed price with its hash).
ALTER TABLE "customer_invoices" ADD CONSTRAINT "customer_invoices_approver_check" CHECK (
  "status" <> 'APPROVED'
  OR "approved_by_id" IS NOT NULL
  OR ("approval_source" = 'AUTO_ON_CONFIRM' AND "auto_initiated_by_id" IS NOT NULL)
);

ALTER TABLE "customer_invoices" ADD CONSTRAINT "customer_invoices_auto_approval_check" CHECK (
  "approval_source" = 'MANUAL'
  OR (
    "auto_initiated_by_id" IS NOT NULL
    AND "auto_rule" IS NOT NULL
    AND ("auto_rule" <> 'AGREED_PRICE' OR "auto_terms_hash" IS NOT NULL)
    AND ("auto_rule" <> 'RATE_CARD_WITH_RIGHT' OR "approved_by_id" = "auto_initiated_by_id")
  )
);
