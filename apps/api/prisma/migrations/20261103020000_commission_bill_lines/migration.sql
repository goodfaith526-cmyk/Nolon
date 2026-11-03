-- Plan 07, PR-7c (rule 16a): a supplier bill line of kind COMMISSION, made only from a partner
-- statement. The line kind check (consolidations migration) knew four kinds and refused the fifth,
-- which the partner_commissions migration added to the enum. It is replaced by the same check plus
-- COMMISSION (a statement and nothing else), and every other kind without a statement.
--
-- Not additive (owner sign-off, AGENTS.md rule 4): it drops and adds a CHECK constraint on an
-- existing table. Adding it re-checks every existing line under a short ACCESS EXCLUSIVE lock;
-- every existing line passes (none has a statement, none is COMMISSION).

ALTER TABLE "supplier_bill_lines" DROP CONSTRAINT "supplier_bill_lines_kind_check";
ALTER TABLE "supplier_bill_lines" ADD CONSTRAINT "supplier_bill_lines_kind_check" CHECK (
    ("kind"::text = 'SHIPMENT_COST' AND "charge_type_code" IS NOT NULL AND "shipment_id" IS NOT NULL
        AND "trip_id" IS NULL AND "expense_category_code" IS NULL AND "consolidation_id" IS NULL
        AND "statement_id" IS NULL)
    OR ("kind"::text = 'TRIP' AND "trip_id" IS NOT NULL AND "charge_type_code" IS NULL
        AND "shipment_id" IS NULL AND "expense_category_code" IS NULL AND "consolidation_id" IS NULL
        AND "statement_id" IS NULL)
    OR ("kind"::text = 'EXPENSE' AND "expense_category_code" IS NOT NULL AND "charge_type_code" IS NULL
        AND "shipment_id" IS NULL AND "trip_id" IS NULL AND "consolidation_id" IS NULL
        AND "statement_id" IS NULL)
    OR ("kind"::text = 'CONSOLIDATION' AND "consolidation_id" IS NOT NULL
        AND "charge_type_code" IS NOT NULL AND "shipment_id" IS NULL AND "trip_id" IS NULL
        AND "expense_category_code" IS NULL AND "statement_id" IS NULL)
    OR ("kind"::text = 'COMMISSION' AND "statement_id" IS NOT NULL
        AND "charge_type_code" IS NULL AND "shipment_id" IS NULL AND "trip_id" IS NULL
        AND "expense_category_code" IS NULL AND "consolidation_id" IS NULL));
