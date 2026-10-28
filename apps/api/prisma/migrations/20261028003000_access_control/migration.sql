-- CreateEnum
CREATE TYPE "access_effect" AS ENUM ('ALLOW', 'DENY');

-- CreateTable
CREATE TABLE "teams" (
    "id" UUID NOT NULL,
    "code" VARCHAR(40) NOT NULL,
    "name_ar" VARCHAR(100) NOT NULL,
    "name_en" VARCHAR(100) NOT NULL,
    "system_role" "role",
    "restricted" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "teams_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "team_permission_changes" (
    "team_id" UUID NOT NULL,
    "permission" VARCHAR(80) NOT NULL,
    "effect" "access_effect" NOT NULL,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "team_permission_changes_pkey" PRIMARY KEY ("team_id","permission")
);

-- CreateTable
CREATE TABLE "user_branch_teams" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "team_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "delegation_id" UUID,
    "source_key" UUID NOT NULL,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_branch_teams_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_branch_permissions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "permission" VARCHAR(80) NOT NULL,
    "effect" "access_effect" NOT NULL,
    "delegation_id" UUID,
    "source_key" UUID NOT NULL,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_branch_permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "branch_blocked_permissions" (
    "branch_id" UUID NOT NULL,
    "permission" VARCHAR(80) NOT NULL,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "branch_blocked_permissions_pkey" PRIMARY KEY ("branch_id","permission")
);

-- CreateTable
CREATE TABLE "branch_delegations" (
    "id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "delegate_user_id" UUID NOT NULL,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ(3),
    "revoked_by_id" UUID,

    CONSTRAINT "branch_delegations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "branch_delegation_permissions" (
    "delegation_id" UUID NOT NULL,
    "permission" VARCHAR(80) NOT NULL,

    CONSTRAINT "branch_delegation_permissions_pkey" PRIMARY KEY ("delegation_id","permission")
);

-- CreateTable
CREATE TABLE "access_state" (
    "id" SMALLINT NOT NULL,
    "version" BIGINT NOT NULL,

    CONSTRAINT "access_state_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "teams_code_key" ON "teams"("code");

-- CreateIndex
CREATE UNIQUE INDEX "teams_system_role_key" ON "teams"("system_role");

-- CreateIndex
CREATE INDEX "user_branch_teams_team_id_idx" ON "user_branch_teams"("team_id");

-- CreateIndex
CREATE INDEX "user_branch_teams_branch_id_idx" ON "user_branch_teams"("branch_id");

-- CreateIndex
CREATE INDEX "user_branch_teams_delegation_id_idx" ON "user_branch_teams"("delegation_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_branch_teams_user_id_team_id_branch_id_source_key_key" ON "user_branch_teams"("user_id", "team_id", "branch_id", "source_key");

-- CreateIndex
CREATE INDEX "user_branch_permissions_branch_id_idx" ON "user_branch_permissions"("branch_id");

-- CreateIndex
CREATE INDEX "user_branch_permissions_delegation_id_idx" ON "user_branch_permissions"("delegation_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_branch_permissions_user_id_branch_id_permission_source_key" ON "user_branch_permissions"("user_id", "branch_id", "permission", "source_key");

-- CreateIndex
CREATE INDEX "branch_delegations_branch_id_idx" ON "branch_delegations"("branch_id");

-- CreateIndex
CREATE INDEX "branch_delegations_delegate_user_id_idx" ON "branch_delegations"("delegate_user_id");

-- AddForeignKey
ALTER TABLE "teams" ADD CONSTRAINT "teams_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_permission_changes" ADD CONSTRAINT "team_permission_changes_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_permission_changes" ADD CONSTRAINT "team_permission_changes_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_branch_teams" ADD CONSTRAINT "user_branch_teams_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_branch_teams" ADD CONSTRAINT "user_branch_teams_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_branch_teams" ADD CONSTRAINT "user_branch_teams_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_branch_teams" ADD CONSTRAINT "user_branch_teams_delegation_id_fkey" FOREIGN KEY ("delegation_id") REFERENCES "branch_delegations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_branch_teams" ADD CONSTRAINT "user_branch_teams_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_branch_permissions" ADD CONSTRAINT "user_branch_permissions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_branch_permissions" ADD CONSTRAINT "user_branch_permissions_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_branch_permissions" ADD CONSTRAINT "user_branch_permissions_delegation_id_fkey" FOREIGN KEY ("delegation_id") REFERENCES "branch_delegations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_branch_permissions" ADD CONSTRAINT "user_branch_permissions_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branch_blocked_permissions" ADD CONSTRAINT "branch_blocked_permissions_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branch_blocked_permissions" ADD CONSTRAINT "branch_blocked_permissions_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branch_delegations" ADD CONSTRAINT "branch_delegations_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branch_delegations" ADD CONSTRAINT "branch_delegations_delegate_user_id_fkey" FOREIGN KEY ("delegate_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branch_delegations" ADD CONSTRAINT "branch_delegations_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branch_delegations" ADD CONSTRAINT "branch_delegations_revoked_by_id_fkey" FOREIGN KEY ("revoked_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branch_delegation_permissions" ADD CONSTRAINT "branch_delegation_permissions_delegation_id_fkey" FOREIGN KEY ("delegation_id") REFERENCES "branch_delegations"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Owner-given rows carry the zero uuid as their source, delegated rows the delegation's id.
ALTER TABLE "user_branch_teams" ADD CONSTRAINT "user_branch_teams_source_key" CHECK ("source_key" = COALESCE("delegation_id", '00000000-0000-0000-0000-000000000000'::uuid));
ALTER TABLE "user_branch_permissions" ADD CONSTRAINT "user_branch_permissions_source_key" CHECK ("source_key" = COALESCE("delegation_id", '00000000-0000-0000-0000-000000000000'::uuid));

-- Plan 03, F114-3: a DENY comes from the owner only, never through a delegation.
ALTER TABLE "user_branch_permissions" ADD CONSTRAINT "user_branch_permissions_deny_owner_only" CHECK ("effect" = 'ALLOW' OR "delegation_id" IS NULL);

-- The single access_state row.
ALTER TABLE "access_state" ADD CONSTRAINT "access_state_single_row" CHECK ("id" = 1);

-- System teams: one per role, ids fixed. The Driver is restricted (plan 03, F114-2).
INSERT INTO "teams" ("id", "code", "name_ar", "name_en", "system_role", "restricted", "is_active", "created_at", "updated_at") VALUES
  ('5a0e0000-0000-4000-8000-000000000001', 'ADMINISTRATOR', 'المدير العام', 'Administrator', 'ADMINISTRATOR', false, true, now(), now()),
  ('5a0e0000-0000-4000-8000-000000000002', 'MANAGEMENT', 'الإدارة', 'Management', 'MANAGEMENT', false, true, now(), now()),
  ('5a0e0000-0000-4000-8000-000000000003', 'BRANCH_MANAGER', 'مدير الفرع', 'Branch manager', 'BRANCH_MANAGER', false, true, now(), now()),
  ('5a0e0000-0000-4000-8000-000000000004', 'SALES', 'المبيعات', 'Sales', 'SALES', false, true, now(), now()),
  ('5a0e0000-0000-4000-8000-000000000005', 'OPERATIONS', 'العمليات', 'Operations', 'OPERATIONS', false, true, now(), now()),
  ('5a0e0000-0000-4000-8000-000000000006', 'FINANCE', 'المالية', 'Finance', 'FINANCE', false, true, now(), now()),
  ('5a0e0000-0000-4000-8000-000000000007', 'WAREHOUSE', 'المستودع', 'Warehouse', 'WAREHOUSE', false, true, now(), now()),
  ('5a0e0000-0000-4000-8000-000000000008', 'CUSTOMS', 'الجمارك', 'Customs', 'CUSTOMS', false, true, now(), now()),
  ('5a0e0000-0000-4000-8000-000000000009', 'DRIVER', 'السائقون', 'Drivers', 'DRIVER', true, true, now(), now()),
  ('5a0e0000-0000-4000-8000-00000000000a', 'SALES_MARKETING_MANAGER', 'مدير المبيعات والتسويق', 'Sales & marketing manager', 'SALES_MARKETING_MANAGER', false, true, now(), now()),
  ('5a0e0000-0000-4000-8000-00000000000b', 'OUTLET_STAFF', 'موظفو منافذ البيع', 'Outlet staff', 'OUTLET_STAFF', true, true, now(), now());

INSERT INTO "access_state" ("id", "version") VALUES (1, 0);

-- A team's code, role and restriction never change, and a team is restricted exactly when it is
-- a security-scope role (the Driver; the outlet staff role when it lands, plan 03 section 4).
CREATE FUNCTION "teams_fixed_identity"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."restricted" <> COALESCE(NEW."system_role"::text IN ('DRIVER', 'OUTLET_STAFF'), false) THEN
    RAISE EXCEPTION 'only the Driver and outlet staff teams are restricted, and they always are';
  END IF;
  IF TG_OP = 'INSERT' THEN
    RETURN NEW;
  ELSIF NEW."code" <> OLD."code"
     OR COALESCE(NEW."system_role"::text, '') <> COALESCE(OLD."system_role"::text, '')
     OR NEW."restricted" <> OLD."restricted" THEN
    RAISE EXCEPTION 'a team''s code, role and restriction are fixed';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "teams_fixed_identity"
  BEFORE INSERT OR UPDATE ON "teams"
  FOR EACH ROW EXECUTE FUNCTION "teams_fixed_identity"();

CREATE FUNCTION "team_permission_changes_restricted"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."effect" = 'ALLOW' AND EXISTS (
    SELECT 1 FROM "teams" t WHERE t."id" = NEW."team_id" AND t."restricted"
  ) THEN
    RAISE EXCEPTION 'a restricted team takes no added permission';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "team_permission_changes_restricted"
  BEFORE INSERT OR UPDATE ON "team_permission_changes"
  FOR EACH ROW EXECUTE FUNCTION "team_permission_changes_restricted"();

CREATE FUNCTION "user_branch_teams_not_restricted"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "teams" t WHERE t."id" = NEW."team_id" AND t."restricted") THEN
    RAISE EXCEPTION 'a restricted team is given through user_roles only';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "user_branch_teams_not_restricted"
  BEFORE INSERT OR UPDATE ON "user_branch_teams"
  FOR EACH ROW EXECUTE FUNCTION "user_branch_teams_not_restricted"();
