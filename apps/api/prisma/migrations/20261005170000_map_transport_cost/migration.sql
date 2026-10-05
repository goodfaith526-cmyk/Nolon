-- Maps the new TRANSPORT_COST role to 5300 "Transport cost" (annex C), as the seed of
-- 20261003181158 maps the other roles. The accountant can remap it from the settings.
INSERT INTO "account_mappings" ("role", "account_id", "updated_at")
SELECT 'TRANSPORT_COST'::"posting_role", a."id", CURRENT_TIMESTAMP
FROM "accounts" a
WHERE a."code" = '5300'
ON CONFLICT ("role") DO NOTHING;
