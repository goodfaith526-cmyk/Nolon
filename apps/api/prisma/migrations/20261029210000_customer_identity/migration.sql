-- AlterEnum
ALTER TYPE "api_scope" ADD VALUE 'CUSTOMER_PROFILES_WRITE';

-- CreateTable
CREATE TABLE "customer_profiles" (
    "id" UUID NOT NULL,
    "company_id" VARCHAR(100) NOT NULL,
    "number" VARCHAR(40) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "name" VARCHAR(200),
    "phone" VARCHAR(20),
    "phone_verified" BOOLEAN NOT NULL DEFAULT false,
    "residence_city_id" UUID,
    "address" VARCHAR(1000),
    "follow_up_branch_id" UUID,
    "follow_up_review" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "customer_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_channel_identities" (
    "id" UUID NOT NULL,
    "company_id" VARCHAR(100) NOT NULL,
    "channel" VARCHAR(20) NOT NULL,
    "subject_id" VARCHAR(32) NOT NULL,
    "profile_id" UUID,
    "username" VARCHAR(64),
    "display_name" VARCHAR(200),
    "observed_at" TIMESTAMPTZ(3) NOT NULL,
    "blocked" BOOLEAN NOT NULL DEFAULT false,
    "pending" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_channel_identities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_profile_conversations" (
    "id" UUID NOT NULL,
    "company_id" VARCHAR(100) NOT NULL,
    "api_client_id" UUID NOT NULL,
    "conversation_id" VARCHAR(128) NOT NULL,
    "identity_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_profile_conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_profile_operations" (
    "id" UUID NOT NULL,
    "company_id" VARCHAR(100) NOT NULL,
    "api_client_id" UUID NOT NULL,
    "identity_id" UUID NOT NULL,
    "idempotency_key" VARCHAR(100) NOT NULL,
    "content_hash" CHAR(64) NOT NULL,
    "result" JSONB NOT NULL,
    "actor" VARCHAR(30) NOT NULL DEFAULT 'ai_agent',
    "context" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_profile_operations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_profile_field_evidence" (
    "id" UUID NOT NULL,
    "profile_id" UUID NOT NULL,
    "operation_id" UUID NOT NULL,
    "field" VARCHAR(40) NOT NULL,
    "value" VARCHAR(1000) NOT NULL,
    "source" VARCHAR(40) NOT NULL,
    "verified" BOOLEAN NOT NULL,
    "applied" BOOLEAN NOT NULL,
    "message_id" VARCHAR(128),
    "observed_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_profile_field_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_followup_rules" (
    "id" UUID NOT NULL,
    "company_id" VARCHAR(100) NOT NULL,
    "residence_city_id" UUID NOT NULL,
    "service_code" VARCHAR(40),
    "branch_id" UUID NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "customer_followup_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_followup_history" (
    "id" UUID NOT NULL,
    "profile_id" UUID NOT NULL,
    "operation_id" UUID NOT NULL,
    "before_branch_id" UUID,
    "after_branch_id" UUID,
    "reason" VARCHAR(40) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_followup_history_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "customer_profiles_company_id_phone_idx" ON "customer_profiles"("company_id", "phone");

-- CreateIndex
CREATE UNIQUE INDEX "customer_profiles_company_id_number_key" ON "customer_profiles"("company_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "customer_profiles_company_id_id_key" ON "customer_profiles"("company_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "customer_channel_identities_company_id_channel_subject_id_key" ON "customer_channel_identities"("company_id", "channel", "subject_id");

-- CreateIndex
CREATE UNIQUE INDEX "customer_channel_identities_company_id_id_key" ON "customer_channel_identities"("company_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "customer_profile_conversations_company_id_api_client_id_con_key" ON "customer_profile_conversations"("company_id", "api_client_id", "conversation_id");

-- CreateIndex
CREATE INDEX "customer_profile_operations_company_id_api_client_id_create_idx" ON "customer_profile_operations"("company_id", "api_client_id", "created_at");

-- CreateIndex
CREATE INDEX "customer_profile_operations_company_id_identity_id_created__idx" ON "customer_profile_operations"("company_id", "identity_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "customer_profile_operations_company_id_api_client_id_idempo_key" ON "customer_profile_operations"("company_id", "api_client_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "customer_profile_field_evidence_profile_id_created_at_idx" ON "customer_profile_field_evidence"("profile_id", "created_at");

-- CreateIndex
CREATE INDEX "customer_followup_rules_company_id_residence_city_id_is_act_idx" ON "customer_followup_rules"("company_id", "residence_city_id", "is_active");

-- CreateIndex
CREATE INDEX "customer_followup_history_profile_id_created_at_idx" ON "customer_followup_history"("profile_id", "created_at");

-- AddForeignKey
ALTER TABLE "customer_channel_identities" ADD CONSTRAINT "customer_channel_identities_company_id_profile_id_fkey" FOREIGN KEY ("company_id", "profile_id") REFERENCES "customer_profiles"("company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_profile_conversations" ADD CONSTRAINT "customer_profile_conversations_company_id_identity_id_fkey" FOREIGN KEY ("company_id", "identity_id") REFERENCES "customer_channel_identities"("company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_profile_operations" ADD CONSTRAINT "customer_profile_operations_company_id_identity_id_fkey" FOREIGN KEY ("company_id", "identity_id") REFERENCES "customer_channel_identities"("company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_profile_field_evidence" ADD CONSTRAINT "customer_profile_field_evidence_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "customer_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_profile_field_evidence" ADD CONSTRAINT "customer_profile_field_evidence_operation_id_fkey" FOREIGN KEY ("operation_id") REFERENCES "customer_profile_operations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_followup_history" ADD CONSTRAINT "customer_followup_history_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "customer_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_followup_history" ADD CONSTRAINT "customer_followup_history_operation_id_fkey" FOREIGN KEY ("operation_id") REFERENCES "customer_profile_operations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
