-- CreateEnum
CREATE TYPE "invoice_kind" AS ENUM ('MAIN', 'ADDITIONAL');

-- AlterTable
ALTER TABLE "customer_invoices" ADD COLUMN     "kind" "invoice_kind" NOT NULL DEFAULT 'MAIN';
