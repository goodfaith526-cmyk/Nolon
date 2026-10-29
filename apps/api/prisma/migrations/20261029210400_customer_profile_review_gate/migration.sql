-- AlterTable
ALTER TABLE "customer_profiles" ADD COLUMN     "needs_review" BOOLEAN NOT NULL DEFAULT false;


-- CreateIndex
CREATE INDEX "customer_profiles_company_id_needs_review_created_at_id_idx" ON "customer_profiles"("company_id", "needs_review", "created_at", "id");

-- AddForeignKey
ALTER TABLE "customer_profiles" ADD CONSTRAINT "customer_profiles_residence_city_id_fkey" FOREIGN KEY ("residence_city_id") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_profiles" ADD CONSTRAINT "customer_profiles_follow_up_branch_id_fkey" FOREIGN KEY ("follow_up_branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_profile_conversations" ADD CONSTRAINT "customer_profile_conversations_api_client_id_fkey" FOREIGN KEY ("api_client_id") REFERENCES "api_clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_profile_operations" ADD CONSTRAINT "customer_profile_operations_api_client_id_fkey" FOREIGN KEY ("api_client_id") REFERENCES "api_clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_followup_rules" ADD CONSTRAINT "customer_followup_rules_residence_city_id_fkey" FOREIGN KEY ("residence_city_id") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_followup_rules" ADD CONSTRAINT "customer_followup_rules_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_followup_history" ADD CONSTRAINT "customer_followup_history_before_branch_id_fkey" FOREIGN KEY ("before_branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_followup_history" ADD CONSTRAINT "customer_followup_history_after_branch_id_fkey" FOREIGN KEY ("after_branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_profile_reviews" ADD CONSTRAINT "customer_profile_reviews_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- A bound bot request carries both identifiers or neither; old requests keep NULL/NULL.
ALTER TABLE "cs_booking_requests" ADD CONSTRAINT "cs_booking_requests_profile_pair_check"
  CHECK (("profile_id" IS NULL) = ("conversation_id" IS NULL));
