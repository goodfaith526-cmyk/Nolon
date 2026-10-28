-- AlterTable
ALTER TABLE "container_types" ADD COLUMN     "max_payload_kg" DECIMAL(18,4),
ADD COLUMN     "max_volume_cbm" DECIMAL(18,4);

-- A limit, when set, is positive.
ALTER TABLE "container_types"
    ADD CONSTRAINT "container_types_max_volume_cbm_positive" CHECK ("max_volume_cbm" > 0),
    ADD CONSTRAINT "container_types_max_payload_kg_positive" CHECK ("max_payload_kg" > 0);

-- Default usable space (owner, 2026-10-27, س1): defaults, not verified limits; administrators set
-- their real ones. Only rows with no limit yet; OTHER stays without.
UPDATE "container_types" AS t
SET "max_volume_cbm" = v."cbm", "max_payload_kg" = v."kg"
FROM (VALUES
    ('20GP', 28::numeric, 28000::numeric),
    ('40GP', 58::numeric, 26500::numeric),
    ('40HC', 68::numeric, 26500::numeric)
) AS v ("code", "cbm", "kg")
WHERE t."code" = v."code" AND t."max_volume_cbm" IS NULL AND t."max_payload_kg" IS NULL;
