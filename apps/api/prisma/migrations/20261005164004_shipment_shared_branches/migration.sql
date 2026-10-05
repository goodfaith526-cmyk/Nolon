-- Annex A: a shipment between branches (DXB -> KRT) is visible to the users of both. Other
-- branches working on a shipment besides its owner. New table only; existing shipments keep
-- their own branch. The service keeps the owning branch out of the list.

-- CreateTable
CREATE TABLE "shipment_branches" (
    "shipment_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shipment_branches_pkey" PRIMARY KEY ("shipment_id","branch_id")
);

-- CreateIndex
CREATE INDEX "shipment_branches_branch_id_idx" ON "shipment_branches"("branch_id");

-- AddForeignKey
ALTER TABLE "shipment_branches" ADD CONSTRAINT "shipment_branches_shipment_id_fkey" FOREIGN KEY ("shipment_id") REFERENCES "shipments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_branches" ADD CONSTRAINT "shipment_branches_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
