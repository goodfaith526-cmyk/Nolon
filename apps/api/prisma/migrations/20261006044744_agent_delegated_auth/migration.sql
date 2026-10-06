-- CreateTable
CREATE TABLE "agent_clients" (
    "id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "client_id" VARCHAR(40) NOT NULL,
    "secret_hash" CHAR(64) NOT NULL,
    "redirect_uri" VARCHAR(500) NOT NULL,
    "audience" VARCHAR(100) NOT NULL,
    "tenant" VARCHAR(100) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ(3),
    "revoked_by_id" UUID,

    CONSTRAINT "agent_clients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_auth_codes" (
    "id" UUID NOT NULL,
    "code_hash" CHAR(64) NOT NULL,
    "agent_client_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "code_challenge" CHAR(43) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "used_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_auth_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_tokens" (
    "id" UUID NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "agent_client_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "auth_code_id" UUID NOT NULL,
    "issued_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),

    CONSTRAINT "agent_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_access_events" (
    "id" BIGSERIAL NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "agent_token_id" UUID NOT NULL,
    "agent_client_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "method" VARCHAR(10) NOT NULL,
    "route" VARCHAR(200) NOT NULL,
    "allowed" BOOLEAN NOT NULL,

    CONSTRAINT "agent_access_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "agent_clients_client_id_key" ON "agent_clients"("client_id");

-- CreateIndex
CREATE UNIQUE INDEX "agent_auth_codes_code_hash_key" ON "agent_auth_codes"("code_hash");

-- CreateIndex
CREATE UNIQUE INDEX "agent_auth_codes_id_user_id_session_id_agent_client_id_key" ON "agent_auth_codes"("id", "user_id", "session_id", "agent_client_id");

-- CreateIndex
CREATE INDEX "agent_auth_codes_agent_client_id_idx" ON "agent_auth_codes"("agent_client_id");

-- CreateIndex
CREATE INDEX "agent_auth_codes_user_id_idx" ON "agent_auth_codes"("user_id");

-- CreateIndex
CREATE INDEX "agent_auth_codes_session_id_idx" ON "agent_auth_codes"("session_id");

-- CreateIndex
CREATE UNIQUE INDEX "agent_tokens_token_hash_key" ON "agent_tokens"("token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "agent_tokens_auth_code_id_key" ON "agent_tokens"("auth_code_id");

-- CreateIndex
CREATE UNIQUE INDEX "agent_tokens_id_user_id_agent_client_id_key" ON "agent_tokens"("id", "user_id", "agent_client_id");

-- CreateIndex
CREATE INDEX "agent_tokens_agent_client_id_idx" ON "agent_tokens"("agent_client_id");

-- CreateIndex
CREATE INDEX "agent_tokens_user_id_idx" ON "agent_tokens"("user_id");

-- CreateIndex
CREATE INDEX "agent_tokens_session_id_idx" ON "agent_tokens"("session_id");

-- CreateIndex
CREATE INDEX "agent_access_events_user_id_occurred_at_idx" ON "agent_access_events"("user_id", "occurred_at");

-- CreateIndex
CREATE INDEX "agent_access_events_agent_client_id_occurred_at_idx" ON "agent_access_events"("agent_client_id", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_id_user_id_key" ON "sessions"("id", "user_id");

-- AddForeignKey
ALTER TABLE "agent_clients" ADD CONSTRAINT "agent_clients_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_clients" ADD CONSTRAINT "agent_clients_revoked_by_id_fkey" FOREIGN KEY ("revoked_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_auth_codes" ADD CONSTRAINT "agent_auth_codes_agent_client_id_fkey" FOREIGN KEY ("agent_client_id") REFERENCES "agent_clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_auth_codes" ADD CONSTRAINT "agent_auth_codes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_auth_codes" ADD CONSTRAINT "agent_auth_codes_session_id_user_id_fkey" FOREIGN KEY ("session_id", "user_id") REFERENCES "sessions"("id", "user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_tokens" ADD CONSTRAINT "agent_tokens_agent_client_id_fkey" FOREIGN KEY ("agent_client_id") REFERENCES "agent_clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_tokens" ADD CONSTRAINT "agent_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_tokens" ADD CONSTRAINT "agent_tokens_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_tokens" ADD CONSTRAINT "agent_tokens_auth_code_id_user_id_session_id_agent_client__fkey" FOREIGN KEY ("auth_code_id", "user_id", "session_id", "agent_client_id") REFERENCES "agent_auth_codes"("id", "user_id", "session_id", "agent_client_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_access_events" ADD CONSTRAINT "agent_access_events_agent_token_id_user_id_agent_client_id_fkey" FOREIGN KEY ("agent_token_id", "user_id", "agent_client_id") REFERENCES "agent_tokens"("id", "user_id", "agent_client_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_access_events" ADD CONSTRAINT "agent_access_events_agent_client_id_fkey" FOREIGN KEY ("agent_client_id") REFERENCES "agent_clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_access_events" ADD CONSTRAINT "agent_access_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Hand-written. Secrets, codes and tokens are SHA-256 hex digests; a PKCE S256 challenge is 43
-- base64url characters; a revoked client is inactive and says when and by whom.
ALTER TABLE "agent_clients" ADD CONSTRAINT "agent_clients_secret_hash_check" CHECK ("secret_hash" ~ '^[0-9a-f]{64}$');
ALTER TABLE "agent_clients" ADD CONSTRAINT "agent_clients_redirect_uri_check" CHECK ("redirect_uri" ~ '^https?://');
ALTER TABLE "agent_clients" ADD CONSTRAINT "agent_clients_revoked_check" CHECK (
  ("revoked_at" IS NULL AND "revoked_by_id" IS NULL)
  OR ("revoked_at" IS NOT NULL AND "revoked_by_id" IS NOT NULL AND NOT "is_active"));
ALTER TABLE "agent_auth_codes" ADD CONSTRAINT "agent_auth_codes_code_hash_check" CHECK ("code_hash" ~ '^[0-9a-f]{64}$');
ALTER TABLE "agent_auth_codes" ADD CONSTRAINT "agent_auth_codes_challenge_check" CHECK ("code_challenge" ~ '^[A-Za-z0-9_-]{43}$');
-- A code lives 60 seconds at most (AUTH_CODE_TTL_MS); the database refuses anything longer.
ALTER TABLE "agent_auth_codes" ADD CONSTRAINT "agent_auth_codes_expiry_check" CHECK (
  "expires_at" > "created_at" AND "expires_at" <= "created_at" + interval '60 seconds');
ALTER TABLE "agent_tokens" ADD CONSTRAINT "agent_tokens_token_hash_check" CHECK ("token_hash" ~ '^[0-9a-f]{64}$');
-- The longest token the API issues is 10 minutes; the database refuses anything longer.
ALTER TABLE "agent_tokens" ADD CONSTRAINT "agent_tokens_lifetime_check" CHECK (
  "expires_at" > "issued_at" AND "expires_at" <= "issued_at" + interval '10 minutes');

-- The assistant's access log is append-only, as audit_events.
CREATE FUNCTION "agent_access_events_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'Agent access events cannot be changed or deleted';
END;
$$;

CREATE TRIGGER "agent_access_events_append_only"
    BEFORE UPDATE OR DELETE ON "agent_access_events"
    FOR EACH ROW EXECUTE FUNCTION "agent_access_events_append_only"();

CREATE TRIGGER "agent_access_events_no_truncate"
    BEFORE TRUNCATE ON "agent_access_events"
    FOR EACH STATEMENT EXECUTE FUNCTION "agent_access_events_append_only"();
