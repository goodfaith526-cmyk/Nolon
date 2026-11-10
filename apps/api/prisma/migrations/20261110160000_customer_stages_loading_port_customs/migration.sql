-- Plan 15-2 (owner, 2026-11-10: the bookings bot tells the customer about every stage): two new
-- customer stages, and the mapping that sends the shipment's statuses to them.
--   LOADED      «في ميناء الإرسال»     the container is loaded at the port of loading (status LOADED)
--   IN_CUSTOMS  «تحت التخليص الجمركي»  customs at the arrival port (status CUSTOMS_IN_PROGRESS)
-- Stages are master data the Administrator edits (customer stages screen), so this changes only
-- what is still as the seed left it: a status is moved only while it still maps to its seed stage,
-- and AT_PORT is renamed only while it still carries its seed name. Data only, no schema change.

-- LOADED goes right after AT_ORIGIN_HUB; the stages after it move down one.
UPDATE "customer_stages"
SET "sort_order" = "sort_order" + 1
WHERE "sort_order" > (SELECT "sort_order" FROM "customer_stages" WHERE "code" = 'AT_ORIGIN_HUB')
  AND NOT EXISTS (SELECT 1 FROM "customer_stages" WHERE "code" = 'LOADED');

INSERT INTO "customer_stages" ("code", "name_ar", "name_en", "sort_order")
SELECT 'LOADED', 'في ميناء الإرسال', 'At the port of loading', "sort_order" + 1
FROM "customer_stages"
WHERE "code" = 'AT_ORIGIN_HUB'
ON CONFLICT ("code") DO NOTHING;

-- IN_CUSTOMS goes right after AT_PORT; the stages after it move down one.
UPDATE "customer_stages"
SET "sort_order" = "sort_order" + 1
WHERE "sort_order" > (SELECT "sort_order" FROM "customer_stages" WHERE "code" = 'AT_PORT')
  AND NOT EXISTS (SELECT 1 FROM "customer_stages" WHERE "code" = 'IN_CUSTOMS');

INSERT INTO "customer_stages" ("code", "name_ar", "name_en", "sort_order")
SELECT 'IN_CUSTOMS', 'تحت التخليص الجمركي', 'In customs clearance', "sort_order" + 1
FROM "customer_stages"
WHERE "code" = 'AT_PORT'
ON CONFLICT ("code") DO NOTHING;

-- Customs now has its own stage: AT_PORT is the arrival itself.
UPDATE "customer_stages"
SET "name_ar" = 'وصلت ميناء الوصول', "name_en" = 'Arrived at the port of arrival'
WHERE "code" = 'AT_PORT'
  AND "name_ar" = 'في الميناء بانتظار التخليص'
  AND "name_en" = 'At the port, awaiting clearance';

UPDATE "shipment_status_stages"
SET "stage_code" = 'LOADED'
WHERE "status" = 'LOADED'
  AND "stage_code" = 'AT_SEA'
  AND EXISTS (SELECT 1 FROM "customer_stages" WHERE "code" = 'LOADED');

UPDATE "shipment_status_stages"
SET "stage_code" = 'IN_CUSTOMS'
WHERE "status" = 'CUSTOMS_IN_PROGRESS'
  AND "stage_code" = 'AT_PORT'
  AND EXISTS (SELECT 1 FROM "customer_stages" WHERE "code" = 'IN_CUSTOMS');
