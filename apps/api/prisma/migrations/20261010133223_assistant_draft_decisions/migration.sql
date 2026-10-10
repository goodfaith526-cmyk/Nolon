-- CreateEnum
CREATE TYPE "draft_decided_via" AS ENUM ('SESSION', 'ASSISTANT');

-- AlterTable
ALTER TABLE "booking_drafts" ADD COLUMN     "decided_via" "draft_decided_via";

-- AlterTable
ALTER TABLE "goods_release_drafts" ADD COLUMN     "decided_via" "draft_decided_via";

-- AlterTable
ALTER TABLE "invoice_drafts" ADD COLUMN     "decided_via" "draft_decided_via";

-- AlterTable
ALTER TABLE "quotation_drafts" ADD COLUMN     "decided_via" "draft_decided_via";

-- AlterTable
ALTER TABLE "receipt_drafts" ADD COLUMN     "decided_via" "draft_decided_via";

-- AlterTable
ALTER TABLE "trip_drafts" ADD COLUMN     "decided_via" "draft_decided_via";

-- CreateTable
CREATE TABLE "assistant_approval_grants" (
    "user_id" UUID NOT NULL,
    "kind" VARCHAR(40) NOT NULL,
    "granted_by_id" UUID NOT NULL,
    "granted_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assistant_approval_grants_pkey" PRIMARY KEY ("user_id","kind")
);

-- AddForeignKey
ALTER TABLE "assistant_approval_grants" ADD CONSTRAINT "assistant_approval_grants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assistant_approval_grants" ADD CONSTRAINT "assistant_approval_grants_granted_by_id_fkey" FOREIGN KEY ("granted_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Only the kinds the chat can decide (packages/shared ASSISTANT_DECIDABLE_KINDS).
ALTER TABLE "assistant_approval_grants" ADD CONSTRAINT "assistant_approval_grants_kind_check"
  CHECK ("kind" IN ('quotation', 'booking', 'trip', 'goods_release', 'invoice', 'receipt'));
