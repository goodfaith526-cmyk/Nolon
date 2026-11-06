-- Plan 13-5: short-lived links to an approved request's documents (waybill, receipts). Additive:
-- a new table, its indexes, foreign keys and a check on it.
-- CreateTable
CREATE TABLE "cs_document_links" (
    "id" UUID NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "api_client_id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "kind" VARCHAR(20) NOT NULL,
    "receipt_id" UUID,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cs_document_links_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "cs_document_links_token_hash_key" ON "cs_document_links"("token_hash");

-- CreateIndex
CREATE INDEX "cs_document_links_request_id_idx" ON "cs_document_links"("request_id");

-- AddForeignKey
ALTER TABLE "cs_document_links" ADD CONSTRAINT "cs_document_links_api_client_id_fkey" FOREIGN KEY ("api_client_id") REFERENCES "api_clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cs_document_links" ADD CONSTRAINT "cs_document_links_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "cs_booking_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A waybill link names no receipt; a receipt link names one.
ALTER TABLE "cs_document_links" ADD CONSTRAINT "cs_document_links_kind_check" CHECK (
  ("kind" = 'WAYBILL' AND "receipt_id" IS NULL) OR ("kind" = 'RECEIPT' AND "receipt_id" IS NOT NULL)
);
