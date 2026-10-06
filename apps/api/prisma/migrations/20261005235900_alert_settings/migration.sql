-- CreateEnum
CREATE TYPE "alert_kind" AS ENUM ('SHIPMENT_PAST_ETA', 'INVOICE_OVERDUE', 'CUSTOMS_STALLED', 'STORAGE_EXCEEDED', 'TRIP_LATE');

-- CreateTable
CREATE TABLE "alert_settings" (
    "kind" "alert_kind" NOT NULL,
    "days" INTEGER NOT NULL,
    "updated_by_id" UUID,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "alert_settings_pkey" PRIMARY KEY ("kind")
);

-- AddForeignKey
ALTER TABLE "alert_settings" ADD CONSTRAINT "alert_settings_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- An alert waits between 0 and 365 days (ALERT_MAX_DAYS).
ALTER TABLE "alert_settings" ADD CONSTRAINT "alert_settings_days_check" CHECK ("days" BETWEEN 0 AND 365);

-- One row per alert, with the starting waits; the Administrator changes them from the screen.
INSERT INTO "alert_settings" ("kind", "days") VALUES
  ('SHIPMENT_PAST_ETA', 0),
  ('INVOICE_OVERDUE', 0),
  ('CUSTOMS_STALLED', 3),
  ('STORAGE_EXCEEDED', 30),
  ('TRIP_LATE', 0);
