-- AlterTable
ALTER TABLE "customs_clearances" ADD COLUMN     "broker_supplier_id" UUID;

-- CreateIndex
CREATE INDEX "customs_clearances_broker_supplier_id_idx" ON "customs_clearances"("broker_supplier_id");

-- AddForeignKey
ALTER TABLE "customs_clearances" ADD CONSTRAINT "customs_clearances_broker_supplier_id_fkey" FOREIGN KEY ("broker_supplier_id") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
