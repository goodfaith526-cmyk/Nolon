-- New identity data only: never weaken existing accounting/document immutability.
ALTER TABLE "customer_profiles" ADD CONSTRAINT "customer_profiles_version_check" CHECK ("version" > 0);
ALTER TABLE "customer_profiles" ADD CONSTRAINT "customer_profiles_verified_phone_check" CHECK (NOT "phone_verified" OR "phone" IS NOT NULL);
ALTER TABLE "customer_channel_identities" ADD CONSTRAINT "customer_channel_identity_subject_check"
  CHECK (("channel" = 'WHATSAPP' AND "subject_id" ~ '^\+[1-9][0-9]{5,14}$')
      OR ("channel" = 'TELEGRAM' AND "subject_id" ~ '^[1-9][0-9]{0,31}$'));
ALTER TABLE "customer_profile_operations" ADD CONSTRAINT "customer_profile_operation_result_check"
  CHECK ("actor" = 'ai_agent' AND "result" ? 'operationId' AND "result" ? 'schemaVersion' AND "result"->>'operationId' = "id"::text
      AND "result"->>'schemaVersion' = 'nolon.customer-identity/1');
ALTER TABLE "customer_profile_reviews" ADD CONSTRAINT "customer_profile_review_actor_check"
  CHECK (("actor" = 'staff' AND "actor_id" IS NOT NULL)
      OR ("actor" IN ('ai_agent', 'system_migration') AND "actor_id" IS NULL));

CREATE FUNCTION "refuse_customer_identity_history_change"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Customer identity history is append-only';
END;
$$;
CREATE TRIGGER "customer_profile_operations_append_only" BEFORE UPDATE OR DELETE ON "customer_profile_operations"
  FOR EACH ROW EXECUTE FUNCTION "refuse_customer_identity_history_change"();
CREATE TRIGGER "customer_profile_field_evidence_append_only" BEFORE UPDATE OR DELETE ON "customer_profile_field_evidence"
  FOR EACH ROW EXECUTE FUNCTION "refuse_customer_identity_history_change"();
CREATE TRIGGER "customer_followup_history_append_only" BEFORE UPDATE OR DELETE ON "customer_followup_history"
  FOR EACH ROW EXECUTE FUNCTION "refuse_customer_identity_history_change"();
CREATE TRIGGER "customer_profile_reviews_append_only" BEFORE UPDATE OR DELETE ON "customer_profile_reviews"
  FOR EACH ROW EXECUTE FUNCTION "refuse_customer_identity_history_change"();
CREATE TRIGGER "customer_profile_conversations_immutable" BEFORE UPDATE OR DELETE ON "customer_profile_conversations"
  FOR EACH ROW EXECUTE FUNCTION "refuse_customer_identity_history_change"();

CREATE FUNCTION "protect_customer_channel_identity"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."company_id" IS DISTINCT FROM OLD."company_id"
     OR NEW."channel" IS DISTINCT FROM OLD."channel"
     OR NEW."subject_id" IS DISTINCT FROM OLD."subject_id"
     OR (OLD."profile_id" IS NOT NULL AND NEW."profile_id" IS DISTINCT FROM OLD."profile_id") THEN
    RAISE EXCEPTION 'A channel identity cannot be reassigned';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "customer_channel_identity_fixed_subject" BEFORE UPDATE ON "customer_channel_identities"
  FOR EACH ROW EXECUTE FUNCTION "protect_customer_channel_identity"();
