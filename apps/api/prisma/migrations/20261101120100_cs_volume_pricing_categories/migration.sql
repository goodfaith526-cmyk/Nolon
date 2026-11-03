-- Owner (2026-11-01): barrels are priced per piece; every other category of personal shipping is
-- priced by volume. The customer gives the pieces and one piece's dimensions in centimetres; NOLON
-- computes the CBM and prices it PER_CBM. Only the seeded CARTON and PALLET rows move from their
-- counted units; rate cards, quotes and requests already written keep the unit they were made with.
-- Owner sign-off (rule 4): open CARTON/PALLET booking requests created before this migration may
-- still hold a piece count in quantity while the category now defaults to PER_CBM — staff must
-- re-quote or type the CBM before approval; new bot traffic sends CBM via the volume quote path.
UPDATE "price_categories" SET "default_unit" = 'PER_CBM'
WHERE "code" IN ('CARTON', 'PALLET') AND "default_unit" IN ('PER_PIECE', 'PER_PALLET');
