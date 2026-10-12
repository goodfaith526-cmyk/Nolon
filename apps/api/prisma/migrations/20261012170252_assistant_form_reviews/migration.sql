-- CreateTable
CREATE TABLE "assistant_form_reviews" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "form" VARCHAR(40) NOT NULL,
    "mode" VARCHAR(20) NOT NULL,
    "values" JSONB NOT NULL,
    "invalid_fields" VARCHAR(100)[],
    "reason" VARCHAR(500) NOT NULL,
    "customer_name" VARCHAR(200),
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assistant_form_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "assistant_form_reviews_user_id_idx" ON "assistant_form_reviews"("user_id");

-- CreateIndex
CREATE INDEX "assistant_form_reviews_expires_at_idx" ON "assistant_form_reviews"("expires_at");

-- AddForeignKey
ALTER TABLE "assistant_form_reviews" ADD CONSTRAINT "assistant_form_reviews_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The forms and modes the API accepts (FORM_REVIEW_FORMS, FORM_REVIEW_MODES in @nolon/shared).
ALTER TABLE "assistant_form_reviews" ADD CONSTRAINT "assistant_form_reviews_form_check" CHECK (
  "form" IN ('booking', 'quotation') AND "mode" IN ('create', 'edit', 'container')
);
