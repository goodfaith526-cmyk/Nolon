-- Plan 13 section 4 (PR 13-4): a window (a drop-off warehouse a partner outlet runs) takes the
-- customer's money into its own cash account, per currency, and the payment approves the
-- booking's pro forma invoice. Not additive: it adds a value to an accounting enum, names
-- accounts and re-adds two checks on customer_invoices (owner's OK 2026-11-06, «موافق»).
-- No existing row changes: every invoice keeps its approval source; the checks scan
-- customer_invoices under a brief lock.

-- AlterEnum
ALTER TYPE "invoice_approval_source" ADD VALUE 'WINDOW_PAYMENT';

-- CreateTable
CREATE TABLE "window_cash_accounts" (
    "id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "account_id" UUID NOT NULL,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "window_cash_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "window_cash_accounts_account_id_key" ON "window_cash_accounts"("account_id");

-- CreateIndex
CREATE UNIQUE INDEX "window_cash_accounts_warehouse_id_currency_key" ON "window_cash_accounts"("warehouse_id", "currency");

-- AddForeignKey
ALTER TABLE "window_cash_accounts" ADD CONSTRAINT "window_cash_accounts_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "window_cash_accounts" ADD CONSTRAINT "window_cash_accounts_currency_fkey" FOREIGN KEY ("currency") REFERENCES "currencies"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "window_cash_accounts" ADD CONSTRAINT "window_cash_accounts_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "window_cash_accounts" ADD CONSTRAINT "window_cash_accounts_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- An approved invoice names its approver, or is an automatic approval naming the person who
-- started it: on confirmation (plan 12) or, now, at the window's payment (plan 13). Compared as
-- text, since the new enum value cannot be used as a literal in the transaction that adds it.
ALTER TABLE "customer_invoices" DROP CONSTRAINT "customer_invoices_approver_check";
ALTER TABLE "customer_invoices" ADD CONSTRAINT "customer_invoices_approver_check" CHECK (
  "status" <> 'APPROVED'
  OR "approved_by_id" IS NOT NULL
  OR ("approval_source"::text IN ('AUTO_ON_CONFIRM', 'WINDOW_PAYMENT') AND "auto_initiated_by_id" IS NOT NULL)
);

-- A window payment's approval names the window user and no plan 12 rule; the plan 12 rules stay
-- as they were.
ALTER TABLE "customer_invoices" DROP CONSTRAINT "customer_invoices_auto_approval_check";
ALTER TABLE "customer_invoices" ADD CONSTRAINT "customer_invoices_auto_approval_check" CHECK (
  "approval_source"::text = 'MANUAL'
  OR (
    "approval_source"::text = 'WINDOW_PAYMENT'
    AND "auto_initiated_by_id" IS NOT NULL
    AND "auto_rule" IS NULL
    AND "auto_terms_hash" IS NULL
  )
  OR (
    "approval_source"::text = 'AUTO_ON_CONFIRM'
    AND "auto_initiated_by_id" IS NOT NULL
    AND "auto_rule" IS NOT NULL
    AND ("auto_rule" <> 'AGREED_PRICE' OR "auto_terms_hash" IS NOT NULL)
    AND ("auto_rule" <> 'RATE_CARD_WITH_RIGHT' OR "approved_by_id" = "auto_initiated_by_id")
  )
);
