-- CreateTable
CREATE TABLE "api_clients" (
    "id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "key_prefix" VARCHAR(16) NOT NULL,
    "key_hash" CHAR(64) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),
    "revoked_by_id" UUID,

    CONSTRAINT "api_clients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_client_branches" (
    "api_client_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,

    CONSTRAINT "api_client_branches_pkey" PRIMARY KEY ("api_client_id","branch_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "api_clients_key_prefix_key" ON "api_clients"("key_prefix");

-- CreateIndex
CREATE INDEX "api_client_branches_branch_id_idx" ON "api_client_branches"("branch_id");

-- AddForeignKey
ALTER TABLE "api_clients" ADD CONSTRAINT "api_clients_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_clients" ADD CONSTRAINT "api_clients_revoked_by_id_fkey" FOREIGN KEY ("revoked_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_client_branches" ADD CONSTRAINT "api_client_branches_api_client_id_fkey" FOREIGN KEY ("api_client_id") REFERENCES "api_clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_client_branches" ADD CONSTRAINT "api_client_branches_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- A key is a SHA-256 hex digest; a revoked key is inactive and says when and by whom.
ALTER TABLE "api_clients" ADD CONSTRAINT "api_clients_key_hash_check" CHECK ("key_hash" ~ '^[0-9a-f]{64}$');
ALTER TABLE "api_clients" ADD CONSTRAINT "api_clients_revoked_check" CHECK (
  ("revoked_at" IS NULL AND "revoked_by_id" IS NULL)
  OR ("revoked_at" IS NOT NULL AND "revoked_by_id" IS NOT NULL AND NOT "is_active"));

-- Customer-safe views (scope section 17): the Customer Service API reads only these. Each lists
-- the columns a customer may see about themselves; nothing Internal or Restricted (notes, credit
-- limits, payment terms, tax and ID numbers, costs, hold and cancel reasons, tracking tokens, who
-- recorded what) is in them. Adding a column here is a classification decision: review it.
CREATE VIEW "cs_customers" AS
SELECT c."id", c."number", c."branch_id", c."kind", c."name", c."company_name", c."phone",
       c."whatsapp", c."email", c."preferred_locale", c."preferred_currency", c."is_active"
FROM "customers" c;

CREATE VIEW "cs_customer_contacts" AS
SELECT k."id", k."customer_id", k."name", k."position", k."phone", k."email", k."can_inquire",
       k."can_receive_cargo", k."can_receive_documents", k."is_primary"
FROM "customer_contacts" k
WHERE k."is_active";

CREATE VIEW "cs_shipments" AS
SELECT s."id", s."number", s."branch_id", s."customer_id", s."mode", s."load_type",
       s."cargo_type", s."status", s."origin_location_id", s."destination_location_id",
       s."current_location_id", s."vessel_name", s."voyage_number", s."bl_number", s."etd",
       s."eta", s."created_at",
       coalesce(i."packages", 0)::int AS "packages", i."weight_kg", i."volume_cbm"
FROM "shipments" s
LEFT JOIN LATERAL (
  SELECT sum(x."quantity") AS "packages", sum(x."weight_kg") AS "weight_kg",
         sum(x."volume_cbm") AS "volume_cbm"
  FROM "shipment_items" x
  WHERE x."shipment_id" = s."id"
) i ON true;

CREATE VIEW "cs_shipment_events" AS
SELECT e."id", e."shipment_id", e."kind", e."status", e."occurred_at", e."location_id"
FROM "shipment_events" e;

CREATE VIEW "cs_invoices" AS
SELECT i."id", i."number", i."branch_id", i."customer_id", i."shipment_id", i."invoice_date",
       i."due_date", i."currency", i."total", i."paid_amount", i."credited_amount",
       i."total" - i."paid_amount" - i."credited_amount" AS "balance"
FROM "customer_invoices" i
WHERE i."status" = 'APPROVED' AND i."number" IS NOT NULL;
