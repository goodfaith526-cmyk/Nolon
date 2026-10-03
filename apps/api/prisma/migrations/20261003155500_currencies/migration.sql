-- CreateTable
CREATE TABLE "currencies" (
    "code" CHAR(3) NOT NULL,
    "name_en" TEXT NOT NULL,
    "name_ar" TEXT NOT NULL,
    "symbol" VARCHAR(8),
    "decimal_places" SMALLINT NOT NULL DEFAULT 2,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "currencies_pkey" PRIMARY KEY ("code")
);

-- Hand-written: integrity checks Prisma cannot express.
ALTER TABLE "currencies"
    ADD CONSTRAINT "currencies_code_format_check" CHECK ("code" ~ '^[A-Z]{3}$'),
    ADD CONSTRAINT "currencies_decimal_places_check" CHECK ("decimal_places" BETWEEN 0 AND 4);

-- Hand-written: initial currency master. Reference data needed in every environment (branches
-- reference it), so it lives in the migration rather than in the demo seed. More currencies are
-- added as rows, not code.
INSERT INTO "currencies" ("code", "name_en", "name_ar", "symbol", "decimal_places", "updated_at") VALUES
    ('USD', 'US Dollar', 'دولار أمريكي', '$', 2, CURRENT_TIMESTAMP),
    ('AED', 'UAE Dirham', 'درهم إماراتي', 'AED', 2, CURRENT_TIMESTAMP),
    ('SAR', 'Saudi Riyal', 'ريال سعودي', 'SAR', 2, CURRENT_TIMESTAMP),
    ('SDG', 'Sudanese Pound', 'جنيه سوداني', 'SDG', 2, CURRENT_TIMESTAMP),
    ('EUR', 'Euro', 'يورو', '€', 2, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO NOTHING;

-- AddForeignKey
ALTER TABLE "branches" ADD CONSTRAINT "branches_default_currency_fkey" FOREIGN KEY ("default_currency") REFERENCES "currencies"("code") ON DELETE RESTRICT ON UPDATE RESTRICT;
