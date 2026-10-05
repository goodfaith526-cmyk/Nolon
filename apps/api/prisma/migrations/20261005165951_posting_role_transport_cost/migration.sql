-- Annex C rules 10, 11 and 11a post trip costs to "transport cost", not the default cost
-- account. A new posting role; it is mapped in the next migration (a new enum value cannot be
-- used in the transaction that adds it).

-- AlterEnum
ALTER TYPE "posting_role" ADD VALUE 'TRANSPORT_COST';
