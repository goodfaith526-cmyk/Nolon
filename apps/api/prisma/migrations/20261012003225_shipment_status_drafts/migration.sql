-- CreateTable
CREATE TABLE "shipment_status_drafts" (
    "id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "shipment_id" UUID NOT NULL,
    "state" "entry_draft_state" NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 1,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "agent_client_id" UUID NOT NULL,
    "created_by_id" UUID NOT NULL,
    "idempotency_key" VARCHAR(100) NOT NULL,
    "payload_hash" CHAR(64) NOT NULL,
    "status" "shipment_status" NOT NULL,
    "location_id" UUID,
    "note" VARCHAR(1000),
    "decided_by_id" UUID,
    "decided_at" TIMESTAMPTZ(3),
    "replaces_draft_id" UUID,
    "decided_via" "draft_decided_via",
    "reject_reason" VARCHAR(500),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "shipment_status_drafts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "shipment_status_drafts_shipment_id_state_idx" ON "shipment_status_drafts"("shipment_id", "state");

-- CreateIndex
CREATE INDEX "shipment_status_drafts_branch_id_state_idx" ON "shipment_status_drafts"("branch_id", "state");

-- CreateIndex
CREATE INDEX "shipment_status_drafts_replaces_draft_id_idx" ON "shipment_status_drafts"("replaces_draft_id");

-- CreateIndex
CREATE UNIQUE INDEX "shipment_status_drafts_agent_client_id_created_by_id_idempo_key" ON "shipment_status_drafts"("agent_client_id", "created_by_id", "idempotency_key");

-- AddForeignKey
ALTER TABLE "shipment_status_drafts" ADD CONSTRAINT "shipment_status_drafts_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_status_drafts" ADD CONSTRAINT "shipment_status_drafts_shipment_id_fkey" FOREIGN KEY ("shipment_id") REFERENCES "shipments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_status_drafts" ADD CONSTRAINT "shipment_status_drafts_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_status_drafts" ADD CONSTRAINT "shipment_status_drafts_agent_client_id_fkey" FOREIGN KEY ("agent_client_id") REFERENCES "agent_clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_status_drafts" ADD CONSTRAINT "shipment_status_drafts_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_status_drafts" ADD CONSTRAINT "shipment_status_drafts_decided_by_id_fkey" FOREIGN KEY ("decided_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A draft's decision fields agree with its state: an open draft carries none, an approval is a
-- person's on the review screen, and only a rejection carries a reason (a rejection from the
-- assistant closes a draft that a newer one replaced at the person's request).
ALTER TABLE "shipment_status_drafts" ADD CONSTRAINT "shipment_status_drafts_decision_check" CHECK (
  ("state" = 'DRAFT' AND "decided_at" IS NULL AND "decided_by_id" IS NULL
     AND "decided_via" IS NULL AND "reject_reason" IS NULL)
  OR ("state" = 'APPROVED' AND "decided_at" IS NOT NULL AND "decided_by_id" IS NOT NULL
     AND "decided_via" = 'SESSION' AND "reject_reason" IS NULL)
  OR ("state" = 'REJECTED' AND "decided_at" IS NOT NULL AND "decided_by_id" IS NOT NULL
     AND "decided_via" IS NOT NULL AND "reject_reason" IS NOT NULL)
);
ALTER TABLE "shipment_status_drafts" ADD CONSTRAINT "shipment_status_drafts_version_check" CHECK (
  "version" >= 1
);
-- Closing, holding and cancelling stay a person's own actions in NOLON.
ALTER TABLE "shipment_status_drafts" ADD CONSTRAINT "shipment_status_drafts_status_check" CHECK (
  "status" NOT IN ('CLOSED', 'ON_HOLD', 'CANCELLED')
);

-- A decided draft never changes again, whatever the application does. (The API has no delete;
-- removing a whole draft row is left to the retention purge and maintenance.)
CREATE FUNCTION "shipment_status_drafts_decided_immutable"() RETURNS trigger AS $$
BEGIN
  IF OLD."state" <> 'DRAFT' THEN
    RAISE EXCEPTION 'Shipment status draft % is decided and cannot change', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "shipment_status_drafts_decided_immutable"
  BEFORE UPDATE ON "shipment_status_drafts"
  FOR EACH ROW EXECUTE FUNCTION "shipment_status_drafts_decided_immutable"();
