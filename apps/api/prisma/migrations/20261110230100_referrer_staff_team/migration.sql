-- Plan 18-4 (owner OK, 2026-11-10 22:04): the Referrer Staff team, restricted like the Driver and
-- Outlet Staff teams (given through user_roles only, takes no added permission). Not additive: it
-- replaces the trigger function that names the restricted roles and adds a system team row.
-- In its own migration: a new enum value cannot be used in the transaction that adds it.
CREATE OR REPLACE FUNCTION "teams_fixed_identity"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."restricted" <> COALESCE(
    NEW."system_role"::text IN ('DRIVER', 'OUTLET_STAFF', 'REFERRER_STAFF'), false) THEN
    RAISE EXCEPTION 'only the Driver, outlet staff and referrer staff teams are restricted, and they always are';
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

INSERT INTO "teams" ("id", "code", "name_ar", "name_en", "system_role", "restricted", "is_active", "created_at", "updated_at") VALUES
  ('5a0e0000-0000-4000-8000-00000000000c', 'REFERRER_STAFF', 'المندوبون', 'Referral brokers', 'REFERRER_STAFF', true, true, now(), now());
