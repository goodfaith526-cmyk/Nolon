-- Entry drafts with no required business fields (owner decision, 2026-10-17; plan
-- docs/no-required-fields-plan.md, section 3.1). A draft is saved with whatever the user filled
-- in; approval refuses it (422 DRAFT_INCOMPLETE) until it is complete and valid, so nothing live
-- or financial is written from an incomplete draft.
--
-- Only draft tables change: their business columns stop being NOT NULL. Never changed: ids,
-- branch, state, version, expiry, agent client, creator, idempotency key, payload hash, evidence,
-- line numbers, timestamps, assistant_draft_keys, the GRN tables, and every live and accounting
-- table. No default is added and no row is rewritten: an absent amount stays null, never zero.
-- Foreign keys stay, nullable with their column. A check on a value holds when it is present.
--
-- NOT ADDITIVE (AGENTS.md rule 4): ALTER COLUMN ... DROP NOT NULL and the re-created checks take an
-- ACCESS EXCLUSIVE lock on each draft table. lock_timeout makes a busy table fail the deploy fast
-- instead of queueing behind it, and the single transaction makes every column change or none.

SET lock_timeout = '3s';

BEGIN;

-- AlterTable
ALTER TABLE "booking_drafts" ALTER COLUMN "customer_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "customer_drafts" ALTER COLUMN "kind" DROP NOT NULL,
ALTER COLUMN "name" DROP NOT NULL,
ALTER COLUMN "phone" DROP NOT NULL;

-- AlterTable
ALTER TABLE "goods_release_drafts" ALTER COLUMN "shipment_id" DROP NOT NULL,
ALTER COLUMN "warehouse_id" DROP NOT NULL,
ALTER COLUMN "packages" DROP NOT NULL;

-- AlterTable
ALTER TABLE "invoice_draft_lines" ALTER COLUMN "charge_type_code" DROP NOT NULL,
ALTER COLUMN "quantity" DROP NOT NULL,
ALTER COLUMN "unit_price" DROP NOT NULL;

-- AlterTable
ALTER TABLE "invoice_drafts" ALTER COLUMN "shipment_id" DROP NOT NULL,
ALTER COLUMN "customer_id" DROP NOT NULL,
ALTER COLUMN "currency" DROP NOT NULL,
ALTER COLUMN "invoice_date" DROP NOT NULL,
ALTER COLUMN "due_date" DROP NOT NULL;

-- AlterTable
ALTER TABLE "new_customer_quotation_draft_lines" ALTER COLUMN "quantity" DROP NOT NULL;

-- AlterTable
ALTER TABLE "new_customer_quotation_drafts" ALTER COLUMN "customer" DROP NOT NULL,
ALTER COLUMN "origin_location_id" DROP NOT NULL,
ALTER COLUMN "destination_location_id" DROP NOT NULL,
ALTER COLUMN "mode" DROP NOT NULL,
ALTER COLUMN "cargo_type" DROP NOT NULL,
ALTER COLUMN "currency" DROP NOT NULL,
ALTER COLUMN "valid_until" DROP NOT NULL;

-- AlterTable
ALTER TABLE "party_drafts" ALTER COLUMN "customer_id" DROP NOT NULL,
ALTER COLUMN "name" DROP NOT NULL;

-- AlterTable
ALTER TABLE "quotation_drafts" ALTER COLUMN "customer_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "receipt_draft_allocations" ALTER COLUMN "invoice_id" DROP NOT NULL,
ALTER COLUMN "amount" DROP NOT NULL;

-- AlterTable
ALTER TABLE "receipt_drafts" ALTER COLUMN "customer_id" DROP NOT NULL,
ALTER COLUMN "receipt_date" DROP NOT NULL,
ALTER COLUMN "currency" DROP NOT NULL,
ALTER COLUMN "amount" DROP NOT NULL,
ALTER COLUMN "cash_account_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "shipment_status_drafts" ALTER COLUMN "shipment_id" DROP NOT NULL,
ALTER COLUMN "status" DROP NOT NULL;

-- AlterTable
ALTER TABLE "trip_draft_shipments" ALTER COLUMN "shipment_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "trip_drafts" ALTER COLUMN "kind" DROP NOT NULL;

-- Checks on a value that may now be absent hold only when it is present. (PostgreSQL already
-- passes a check that evaluates to NULL; the rewrite says so explicitly.)
ALTER TABLE "goods_release_drafts" DROP CONSTRAINT "goods_release_drafts_amounts_check";
ALTER TABLE "goods_release_drafts" ADD CONSTRAINT "goods_release_drafts_amounts_check" CHECK (
  ("packages" IS NULL OR "packages" >= 1) AND ("weight_kg" IS NULL OR "weight_kg" >= 0)
);

ALTER TABLE "customer_drafts" DROP CONSTRAINT "customer_drafts_values_check";
ALTER TABLE "customer_drafts" ADD CONSTRAINT "customer_drafts_values_check" CHECK (
  ("name" IS NULL OR btrim("name") <> '') AND ("phone" IS NULL OR btrim("phone") <> '')
);

ALTER TABLE "invoice_drafts" DROP CONSTRAINT "invoice_drafts_dates_check";
ALTER TABLE "invoice_drafts" ADD CONSTRAINT "invoice_drafts_dates_check" CHECK (
  "invoice_date" IS NULL OR "due_date" IS NULL OR "due_date" >= "invoice_date"
);

ALTER TABLE "invoice_draft_lines" DROP CONSTRAINT "invoice_draft_lines_amounts_check";
ALTER TABLE "invoice_draft_lines" ADD CONSTRAINT "invoice_draft_lines_amounts_check" CHECK (
  ("quantity" IS NULL OR "quantity" > 0) AND ("unit_price" IS NULL OR "unit_price" >= 0)
);

ALTER TABLE "receipt_drafts" DROP CONSTRAINT "receipt_drafts_amount_check";
ALTER TABLE "receipt_drafts" ADD CONSTRAINT "receipt_drafts_amount_check" CHECK (
  "amount" IS NULL OR "amount" > 0
);

ALTER TABLE "receipt_draft_allocations" DROP CONSTRAINT "receipt_draft_allocations_amount_check";
ALTER TABLE "receipt_draft_allocations" ADD CONSTRAINT "receipt_draft_allocations_amount_check" CHECK (
  "amount" IS NULL OR "amount" > 0
);

ALTER TABLE "shipment_status_drafts" DROP CONSTRAINT "shipment_status_drafts_status_check";
ALTER TABLE "shipment_status_drafts" ADD CONSTRAINT "shipment_status_drafts_status_check" CHECK (
  "status" IS NULL OR "status" NOT IN ('CLOSED', 'ON_HOLD', 'CANCELLED')
);

ALTER TABLE "new_customer_quotation_drafts" DROP CONSTRAINT "new_customer_quotation_drafts_customer_check";
ALTER TABLE "new_customer_quotation_drafts" ADD CONSTRAINT "new_customer_quotation_drafts_customer_check" CHECK (
  "customer" IS NULL OR jsonb_typeof("customer") = 'object'
);

COMMIT;

RESET lock_timeout;
