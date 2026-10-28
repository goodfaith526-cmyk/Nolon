-- Owner, 2026-10-28: the owner sets the Outlet Staff team's permissions like any other team's;
-- the role's matrix is only its default. The Driver's team still takes no added permission.
-- Outlet isolation does not depend on this trigger: the API refuses Outlet Staff every route not
-- built for the outlet filter, whatever their team holds. User and access management stay the
-- Administrator's only, here as in the API.
CREATE OR REPLACE FUNCTION "team_permission_changes_restricted"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."effect" = 'ALLOW' AND EXISTS (
    SELECT 1 FROM "teams" t
    WHERE t."id" = NEW."team_id" AND t."restricted"
      AND (
        t."system_role" IS DISTINCT FROM 'OUTLET_STAFF'
        OR split_part(NEW."permission", ':', 1) IN ('users', 'access_control')
      )
  ) THEN
    RAISE EXCEPTION 'a restricted team takes no added permission';
  END IF;
  RETURN NEW;
END;
$$;
