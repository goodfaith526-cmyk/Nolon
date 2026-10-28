-- CreateEnum
CREATE TYPE "api_scope" AS ENUM ('CUSTOMER_TOKENS_ISSUE', 'CATALOG_READ', 'QUOTE_READ', 'BOOKING_REQUESTS_CREATE', 'TRACKING_LOOKUP');

-- AlterTable
ALTER TABLE "api_clients" ADD COLUMN     "customers_read" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "api_client_scopes" (
    "api_client_id" UUID NOT NULL,
    "scope" "api_scope" NOT NULL,
    "granted_by_id" UUID NOT NULL,
    "granted_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_client_scopes_pkey" PRIMARY KEY ("api_client_id","scope")
);

-- AddForeignKey
ALTER TABLE "api_client_scopes" ADD CONSTRAINT "api_client_scopes_api_client_id_fkey" FOREIGN KEY ("api_client_id") REFERENCES "api_clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_client_scopes" ADD CONSTRAINT "api_client_scopes_granted_by_id_fkey" FOREIGN KEY ("granted_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
