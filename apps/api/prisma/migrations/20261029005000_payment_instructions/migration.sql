-- CreateEnum
CREATE TYPE "payment_instruction_status" AS ENUM ('DRAFT', 'APPROVED', 'RETIRED');

-- CreateTable
CREATE TABLE "payment_instructions" (
    "id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "text_ar" VARCHAR(2000) NOT NULL,
    "text_en" VARCHAR(2000) NOT NULL,
    "status" "payment_instruction_status" NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by_id" UUID NOT NULL,
    "edited_by_id" UUID NOT NULL,
    "approved_by_id" UUID,
    "approved_at" TIMESTAMPTZ(3),
    "retired_by_id" UUID,
    "retired_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "payment_instructions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "payment_instructions_branch_id_currency_status_idx" ON "payment_instructions"("branch_id", "currency", "status");

-- CreateIndex
CREATE INDEX "payment_instructions_currency_idx" ON "payment_instructions"("currency");

-- AddForeignKey
ALTER TABLE "payment_instructions" ADD CONSTRAINT "payment_instructions_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_instructions" ADD CONSTRAINT "payment_instructions_currency_fkey" FOREIGN KEY ("currency") REFERENCES "currencies"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_instructions" ADD CONSTRAINT "payment_instructions_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_instructions" ADD CONSTRAINT "payment_instructions_edited_by_id_fkey" FOREIGN KEY ("edited_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_instructions" ADD CONSTRAINT "payment_instructions_approved_by_id_fkey" FOREIGN KEY ("approved_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_instructions" ADD CONSTRAINT "payment_instructions_retired_by_id_fkey" FOREIGN KEY ("retired_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Plan 04 section 4.1: one approved instructions per branch and currency, by the database itself.
-- The keys are null on any other row, and nulls never collide: the same as a partial unique index
-- on the approved rows.
CREATE UNIQUE INDEX "payment_instructions_one_approved" ON "payment_instructions"(
    (CASE WHEN "status" = 'APPROVED' THEN "branch_id" END),
    (CASE WHEN "status" = 'APPROVED' THEN "currency" END)
);

-- Two people (F140-1): an approved or retired-after-approval row names an approver other than its
-- maker and other than the person who wrote its current text (edited_by_id).
ALTER TABLE "payment_instructions" ADD CONSTRAINT "payment_instructions_approval_check" CHECK (
    ("status" = 'DRAFT' AND "approved_by_id" IS NULL AND "approved_at" IS NULL)
    OR ("status" = 'APPROVED' AND "approved_by_id" IS NOT NULL AND "approved_at" IS NOT NULL
        AND "approved_by_id" <> "created_by_id" AND "approved_by_id" <> "edited_by_id")
    OR ("status" = 'RETIRED' AND ("approved_by_id" IS NULL) = ("approved_at" IS NULL)
        AND ("approved_by_id" IS NULL
            OR ("approved_by_id" <> "created_by_id" AND "approved_by_id" <> "edited_by_id")))
);

-- An approved row is never edited, only retired; a retired row never changes; neither is deleted.
CREATE FUNCTION "payment_instructions_decided"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD."status" <> 'DRAFT' THEN
            RAISE EXCEPTION 'Decided payment instructions cannot be deleted';
        END IF;
        RETURN OLD;
    END IF;
    IF OLD."status" = 'RETIRED' THEN
        RAISE EXCEPTION 'Retired payment instructions cannot be changed';
    END IF;
    IF OLD."status" = 'APPROVED' AND (
        NEW."status" <> 'RETIRED'
        OR NEW."branch_id" <> OLD."branch_id"
        OR NEW."currency" <> OLD."currency"
        OR NEW."text_ar" <> OLD."text_ar"
        OR NEW."text_en" <> OLD."text_en"
        OR NEW."created_by_id" <> OLD."created_by_id"
        OR NEW."edited_by_id" <> OLD."edited_by_id"
        OR NEW."approved_by_id" IS NULL
        OR NEW."approved_by_id" <> OLD."approved_by_id"
        OR NEW."approved_at" IS NULL
        OR NEW."approved_at" <> OLD."approved_at"
    ) THEN
        RAISE EXCEPTION 'Approved payment instructions are only retired';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "payment_instructions_decided"
    BEFORE UPDATE OR DELETE ON "payment_instructions"
    FOR EACH ROW EXECUTE FUNCTION "payment_instructions_decided"();
