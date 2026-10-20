-- CreateEnum
CREATE TYPE "receipt_application_status" AS ENUM ('ACTIVE', 'REVERSED');

-- AlterEnum
ALTER TYPE "journal_source" ADD VALUE 'RECEIPT_APPLICATION';

-- CreateTable
CREATE TABLE "receipt_applications" (
    "id" UUID NOT NULL,
    "receipt_id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "application_date" DATE NOT NULL,
    "amount" DECIMAL(18,4) NOT NULL,
    "advance_usd" DECIMAL(18,4) NOT NULL,
    "relieved_usd" DECIMAL(18,4) NOT NULL,
    "status" "receipt_application_status" NOT NULL DEFAULT 'ACTIVE',
    "journal_entry_id" UUID NOT NULL,
    "reverse_journal_entry_id" UUID,
    "reverse_reason" TEXT,
    "reversed_at" TIMESTAMPTZ(3),
    "reversed_by_id" UUID,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "receipt_applications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "receipt_applications_journal_entry_id_key" ON "receipt_applications"("journal_entry_id");

-- CreateIndex
CREATE UNIQUE INDEX "receipt_applications_reverse_journal_entry_id_key" ON "receipt_applications"("reverse_journal_entry_id");

-- CreateIndex
CREATE INDEX "receipt_applications_receipt_id_idx" ON "receipt_applications"("receipt_id");

-- CreateIndex
CREATE INDEX "receipt_applications_invoice_id_idx" ON "receipt_applications"("invoice_id");

-- AddForeignKey
ALTER TABLE "receipt_applications" ADD CONSTRAINT "receipt_applications_receipt_id_fkey" FOREIGN KEY ("receipt_id") REFERENCES "receipts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipt_applications" ADD CONSTRAINT "receipt_applications_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "customer_invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipt_applications" ADD CONSTRAINT "receipt_applications_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipt_applications" ADD CONSTRAINT "receipt_applications_journal_entry_id_fkey" FOREIGN KEY ("journal_entry_id") REFERENCES "journal_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipt_applications" ADD CONSTRAINT "receipt_applications_reverse_journal_entry_id_fkey" FOREIGN KEY ("reverse_journal_entry_id") REFERENCES "journal_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipt_applications" ADD CONSTRAINT "receipt_applications_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipt_applications" ADD CONSTRAINT "receipt_applications_reversed_by_id_fkey" FOREIGN KEY ("reversed_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Amounts are positive; a reversed application names its reversing entry, an active one none.
ALTER TABLE "receipt_applications" ADD CONSTRAINT "receipt_applications_amount_check"
  CHECK ("amount" > 0 AND "advance_usd" >= 0 AND "relieved_usd" >= 0);
ALTER TABLE "receipt_applications" ADD CONSTRAINT "receipt_applications_status_check"
  CHECK (("status" = 'ACTIVE') = ("reverse_journal_entry_id" IS NULL)
    AND ("status" = 'ACTIVE') = ("reversed_at" IS NULL));

-- An application is undone by a reversing entry, never deleted or edited: the only change
-- allowed is ACTIVE to REVERSED, filling the reversal's own columns.
CREATE FUNCTION "receipt_applications_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A receipt application is reversed, never deleted';
  END IF;
  IF OLD."status" <> 'ACTIVE' OR NEW."status" <> 'REVERSED'
     OR (NEW."id", NEW."receipt_id", NEW."invoice_id", NEW."branch_id", NEW."application_date",
         NEW."amount", NEW."advance_usd", NEW."relieved_usd", NEW."journal_entry_id",
         NEW."created_by_id", NEW."created_at")
        IS DISTINCT FROM
        (OLD."id", OLD."receipt_id", OLD."invoice_id", OLD."branch_id", OLD."application_date",
         OLD."amount", OLD."advance_usd", OLD."relieved_usd", OLD."journal_entry_id",
         OLD."created_by_id", OLD."created_at") THEN
    RAISE EXCEPTION 'A receipt application only changes from ACTIVE to REVERSED';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "receipt_applications_guard"
  BEFORE UPDATE OR DELETE ON "receipt_applications"
  FOR EACH ROW EXECUTE FUNCTION "receipt_applications_guard"();
