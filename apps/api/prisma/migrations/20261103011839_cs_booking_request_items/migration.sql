-- CreateTable
CREATE TABLE "cs_booking_request_items" (
    "id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "line_no" SMALLINT NOT NULL,
    "price_category_code" VARCHAR(20),
    "bot_kind" JSONB,
    "is_other" BOOLEAN NOT NULL DEFAULT false,
    "description" VARCHAR(500),
    "quantity" DECIMAL(18,4),
    "pieces" INTEGER,
    "length_cm" DECIMAL(10,2),
    "width_cm" DECIMAL(10,2),
    "height_cm" DECIMAL(10,2),
    "weight_kg" DECIMAL(12,3),
    "quote_ref" VARCHAR(40),
    "approved_category_code" VARCHAR(20),
    "approved_quantity" DECIMAL(18,4),
    "approved_total" DECIMAL(18,4),
    "booking_item_id" UUID,
    "resolved_at" TIMESTAMPTZ(3),
    "resolved_by_id" UUID,

    CONSTRAINT "cs_booking_request_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "cs_booking_request_items_booking_item_id_key" ON "cs_booking_request_items"("booking_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "cs_booking_request_items_request_id_line_no_key" ON "cs_booking_request_items"("request_id", "line_no");

-- AddForeignKey
ALTER TABLE "cs_booking_request_items" ADD CONSTRAINT "cs_booking_request_items_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "cs_booking_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cs_booking_request_items" ADD CONSTRAINT "cs_booking_request_items_price_category_code_fkey" FOREIGN KEY ("price_category_code") REFERENCES "price_categories"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cs_booking_request_items" ADD CONSTRAINT "cs_booking_request_items_approved_category_code_fkey" FOREIGN KEY ("approved_category_code") REFERENCES "price_categories"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cs_booking_request_items" ADD CONSTRAINT "cs_booking_request_items_quote_ref_fkey" FOREIGN KEY ("quote_ref") REFERENCES "cs_quotes"("ref") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cs_booking_request_items" ADD CONSTRAINT "cs_booking_request_items_booking_item_id_fkey" FOREIGN KEY ("booking_item_id") REFERENCES "booking_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cs_booking_request_items" ADD CONSTRAINT "cs_booking_request_items_resolved_by_id_fkey" FOREIGN KEY ("resolved_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- One to ten lines; a standard item has a positive quantity; an OTHER item has a description and
-- no category, quantity or price (plan 09 sections 4 and 12).
ALTER TABLE "cs_booking_request_items" ADD CONSTRAINT "cs_booking_request_items_line_check"
    CHECK ("line_no" BETWEEN 1 AND 10);
ALTER TABLE "cs_booking_request_items" ADD CONSTRAINT "cs_booking_request_items_kind_check"
    CHECK (
        ("is_other" AND "description" IS NOT NULL AND "price_category_code" IS NULL
            AND "quantity" IS NULL AND "quote_ref" IS NULL)
        OR (NOT "is_other" AND "quantity" IS NOT NULL AND "quantity" > 0));
ALTER TABLE "cs_booking_request_items" ADD CONSTRAINT "cs_booking_request_items_pieces_check"
    CHECK ("pieces" IS NULL OR "pieces" >= 1);
ALTER TABLE "cs_booking_request_items" ADD CONSTRAINT "cs_booking_request_items_resolved_check"
    CHECK (("resolved_at" IS NULL) = ("resolved_by_id" IS NULL));
