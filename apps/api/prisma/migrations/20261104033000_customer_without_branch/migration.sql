-- Plan 09f (owner, 2026-11-04: «امسح خانة فرع العميل دي»): a customer is of no branch.
-- Destructive: drops customers.branch_id (display only since plan 09d; no rule reads it).
-- The customer-safe view cs_customers selected it, so it is made again without it first.
DROP VIEW "cs_customers";

CREATE VIEW "cs_customers" AS
SELECT c."id", c."number", c."kind", c."name", c."company_name", c."phone",
       c."whatsapp", c."email", c."preferred_locale", c."preferred_currency", c."is_active"
FROM "customers" c;

-- DropForeignKey
ALTER TABLE "customers" DROP CONSTRAINT "customers_branch_id_fkey";

-- DropIndex
DROP INDEX "customers_branch_id_idx";

-- DropIndex
DROP INDEX "customers_profile_id_branch_id_key";

-- AlterTable
ALTER TABLE "customers" DROP COLUMN "branch_id";

-- CreateIndex
CREATE INDEX "customers_profile_id_idx" ON "customers"("profile_id");
