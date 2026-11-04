-- Plan 12 section 6: the ID the recipient showed on a proof of delivery (optional).
ALTER TABLE "proofs_of_delivery" ADD COLUMN "recipient_id_type" VARCHAR(50),
ADD COLUMN "recipient_id_number" VARCHAR(50);

-- Plan 12 section 7: the alert for shipments delivered and not closed.
ALTER TYPE "alert_kind" ADD VALUE 'DELIVERED_NOT_CLOSED';
