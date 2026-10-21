-- AlterEnum
ALTER TYPE "role" ADD VALUE 'OUTLET_STAFF';

-- AlterTable
ALTER TABLE "bookings" ADD COLUMN     "sales_outlet_id" UUID;

-- AlterTable
ALTER TABLE "customers" ADD COLUMN     "acquired_via_outlet_id" UUID;

-- AlterTable
ALTER TABLE "quotations" ADD COLUMN     "sales_outlet_id" UUID;

-- AlterTable
ALTER TABLE "shipments" ADD COLUMN     "sales_outlet_id" UUID;

-- CreateTable
CREATE TABLE "user_partners" (
    "user_id" UUID NOT NULL,
    "partner_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_partners_pkey" PRIMARY KEY ("user_id","partner_id")
);

-- CreateIndex
CREATE INDEX "user_partners_partner_id_idx" ON "user_partners"("partner_id");

-- CreateIndex
CREATE INDEX "bookings_sales_outlet_id_idx" ON "bookings"("sales_outlet_id");

-- CreateIndex
CREATE INDEX "customers_acquired_via_outlet_id_idx" ON "customers"("acquired_via_outlet_id");

-- CreateIndex
CREATE INDEX "quotations_sales_outlet_id_idx" ON "quotations"("sales_outlet_id");

-- CreateIndex
CREATE INDEX "shipments_sales_outlet_id_idx" ON "shipments"("sales_outlet_id");

-- AddForeignKey
ALTER TABLE "user_partners" ADD CONSTRAINT "user_partners_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_partners" ADD CONSTRAINT "user_partners_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_acquired_via_outlet_id_fkey" FOREIGN KEY ("acquired_via_outlet_id") REFERENCES "partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_sales_outlet_id_fkey" FOREIGN KEY ("sales_outlet_id") REFERENCES "partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_sales_outlet_id_fkey" FOREIGN KEY ("sales_outlet_id") REFERENCES "partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_sales_outlet_id_fkey" FOREIGN KEY ("sales_outlet_id") REFERENCES "partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
