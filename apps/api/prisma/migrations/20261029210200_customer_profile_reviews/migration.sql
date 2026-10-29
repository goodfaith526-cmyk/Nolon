-- CreateTable
CREATE TABLE "customer_profile_reviews" (
    "id" UUID NOT NULL,
    "company_id" VARCHAR(100) NOT NULL,
    "actor_id" UUID,
    "actor" VARCHAR(30) NOT NULL DEFAULT 'staff',
    "entity_id" UUID NOT NULL,
    "action" VARCHAR(40) NOT NULL,
    "reason" VARCHAR(1000) NOT NULL,
    "snapshot" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_profile_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "customer_profile_reviews_company_id_entity_id_created_at_idx" ON "customer_profile_reviews"("company_id", "entity_id", "created_at");
