-- AlterTable
ALTER TABLE "customer_drafts" ADD COLUMN     "evidence" JSONB NOT NULL DEFAULT '[]';

-- AlterTable
ALTER TABLE "shipment_status_drafts" ADD COLUMN     "evidence" JSONB NOT NULL DEFAULT '[]';

-- The words are a JSON array (drafts/draft-evidence.ts); on the table this change creates only.
ALTER TABLE "shipment_status_drafts" ADD CONSTRAINT "shipment_status_drafts_evidence_check" CHECK (
  jsonb_typeof("evidence") = 'array'
);
