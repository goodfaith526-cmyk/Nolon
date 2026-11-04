-- Plan 12 section 3: the handover gate's override, recorded on the destination release or the POD.
-- Additive: nullable columns and foreign keys on them.
-- AlterTable
ALTER TABLE "proofs_of_delivery" ADD COLUMN     "payment_override_by_id" UUID,
ADD COLUMN     "payment_override_reason" TEXT;

-- AlterTable
ALTER TABLE "warehouse_movements" ADD COLUMN     "payment_override_by_id" UUID,
ADD COLUMN     "payment_override_reason" TEXT;

-- AddForeignKey
ALTER TABLE "warehouse_movements" ADD CONSTRAINT "warehouse_movements_payment_override_by_id_fkey" FOREIGN KEY ("payment_override_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "proofs_of_delivery" ADD CONSTRAINT "proofs_of_delivery_payment_override_by_id_fkey" FOREIGN KEY ("payment_override_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

