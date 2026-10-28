-- CreateEnum
CREATE TYPE "cs_grant_kind" AS ENUM ('CUSTOMER_PHONE', 'CUSTOMER_WHATSAPP', 'CONTACT_PHONE');

-- CreateEnum
CREATE TYPE "cs_access_level" AS ENUM ('L1', 'L2');

-- CreateTable
CREATE TABLE "cs_customer_tokens" (
    "id" UUID NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "api_client_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "grant_kind" "cs_grant_kind" NOT NULL,
    "contact_id" UUID,
    "phone_hash" CHAR(64) NOT NULL,
    "grant_version" BIGINT NOT NULL,
    "level" "cs_access_level" NOT NULL,
    "issued_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "cs_customer_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cs_access_events" (
    "id" BIGSERIAL NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "api_client_id" UUID NOT NULL,
    "token_id" UUID,
    "customer_id" UUID,
    "channel" VARCHAR(20) NOT NULL,
    "route" VARCHAR(100) NOT NULL,
    "outcome" VARCHAR(20) NOT NULL,

    CONSTRAINT "cs_access_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "cs_customer_tokens_token_hash_key" ON "cs_customer_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "cs_customer_tokens_api_client_id_idx" ON "cs_customer_tokens"("api_client_id");

-- CreateIndex
CREATE INDEX "cs_customer_tokens_customer_id_idx" ON "cs_customer_tokens"("customer_id");

-- CreateIndex
CREATE INDEX "cs_customer_tokens_expires_at_idx" ON "cs_customer_tokens"("expires_at");

-- CreateIndex
CREATE INDEX "cs_access_events_api_client_id_occurred_at_idx" ON "cs_access_events"("api_client_id", "occurred_at");

-- CreateIndex
CREATE INDEX "cs_access_events_customer_id_occurred_at_idx" ON "cs_access_events"("customer_id", "occurred_at");

-- AddForeignKey
ALTER TABLE "cs_customer_tokens" ADD CONSTRAINT "cs_customer_tokens_api_client_id_fkey" FOREIGN KEY ("api_client_id") REFERENCES "api_clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cs_customer_tokens" ADD CONSTRAINT "cs_customer_tokens_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cs_customer_tokens" ADD CONSTRAINT "cs_customer_tokens_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "customer_contacts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cs_access_events" ADD CONSTRAINT "cs_access_events_api_client_id_fkey" FOREIGN KEY ("api_client_id") REFERENCES "api_clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cs_access_events" ADD CONSTRAINT "cs_access_events_token_id_fkey" FOREIGN KEY ("token_id") REFERENCES "cs_customer_tokens"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cs_access_events" ADD CONSTRAINT "cs_access_events_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The customer-service access log is append-only, as agent_access_events.
CREATE FUNCTION "cs_access_events_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'Customer service access events cannot be changed or deleted';
END;
$$;

CREATE TRIGGER "cs_access_events_append_only"
    BEFORE UPDATE OR DELETE ON "cs_access_events"
    FOR EACH ROW EXECUTE FUNCTION "cs_access_events_append_only"();

CREATE TRIGGER "cs_access_events_no_truncate"
    BEFORE TRUNCATE ON "cs_access_events"
    FOR EACH STATEMENT EXECUTE FUNCTION "cs_access_events_append_only"();
