-- Plan 07 (3.4): the accounts of the partner commission roles, and their mapping, as
-- 20261003181158 seeds the others. The accountant can remap them from the settings. An account a
-- user already created with the same code is kept and mapped only when it has the role's type.
INSERT INTO "accounts" ("id", "code", "name_en", "name_ar", "type", "is_postable", "parent_id", "updated_at")
SELECT gen_random_uuid(), v."code", v."name_en", v."name_ar", v."type"::"account_type", true, p."id", CURRENT_TIMESTAMP
FROM (VALUES
    ('5150', 'Partner commissions', 'عمولات الشركاء', 'EXPENSE', '5000'),
    ('2310', 'Accrued partner commissions (clearing)', 'عمولات شركاء مستحقة (وسيط)', 'LIABILITY', '2000')
) AS v("code", "name_en", "name_ar", "type", "parent_code")
LEFT JOIN "accounts" p ON p."code" = v."parent_code"
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "account_mappings" ("role", "account_id", "updated_at")
SELECT m."role"::"posting_role", a."id", CURRENT_TIMESTAMP
FROM (VALUES
    ('COMMISSION_COST', '5150', 'EXPENSE'),
    ('ACCRUED_COMMISSIONS', '2310', 'LIABILITY')
) AS m("role", "code", "type")
JOIN "accounts" a ON a."code" = m."code" AND a."type"::text = m."type"
ON CONFLICT ("role") DO NOTHING;
