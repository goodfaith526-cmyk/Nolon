-- CreateTable
CREATE TABLE "cs_quotes" (
    "ref" VARCHAR(40) NOT NULL,
    "api_client_id" UUID NOT NULL,
    "rate_card_id" UUID NOT NULL,
    "origin_location_id" UUID NOT NULL,
    "destination_location_id" UUID NOT NULL,
    "price_category_code" VARCHAR(20) NOT NULL,
    "mode" "shipping_mode" NOT NULL,
    "load_type" "load_type",
    "cargo_type" "cargo_type" NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "unit" "rate_unit" NOT NULL,
    "quantity" DECIMAL(18,4),
    "price" DECIMAL(18,4) NOT NULL,
    "minimum_charge" DECIMAL(18,4) NOT NULL,
    "total" DECIMAL(18,4),
    "origin_scope" VARCHAR(10) NOT NULL,
    "destination_scope" VARCHAR(10) NOT NULL,
    "quoted_on" DATE NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cs_quotes_pkey" PRIMARY KEY ("ref")
);

-- CreateIndex
CREATE INDEX "cs_quotes_api_client_id_created_at_idx" ON "cs_quotes"("api_client_id", "created_at");

-- CreateIndex
CREATE INDEX "cs_quotes_rate_card_id_idx" ON "cs_quotes"("rate_card_id");

-- CreateIndex
CREATE INDEX "cs_quotes_expires_at_idx" ON "cs_quotes"("expires_at");

-- AddForeignKey
ALTER TABLE "cs_quotes" ADD CONSTRAINT "cs_quotes_api_client_id_fkey" FOREIGN KEY ("api_client_id") REFERENCES "api_clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cs_quotes" ADD CONSTRAINT "cs_quotes_rate_card_id_fkey" FOREIGN KEY ("rate_card_id") REFERENCES "rate_cards"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A quote is never changed after it is written: a booking request (R3) trusts what it holds.
CREATE FUNCTION "cs_quotes_unchanged"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'Customer service quotes cannot be changed';
END;
$$;

CREATE TRIGGER "cs_quotes_unchanged"
    BEFORE UPDATE ON "cs_quotes"
    FOR EACH ROW EXECUTE FUNCTION "cs_quotes_unchanged"();
