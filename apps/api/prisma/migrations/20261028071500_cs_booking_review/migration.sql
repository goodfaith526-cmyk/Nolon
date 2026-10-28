-- AlterTable
ALTER TABLE "cs_booking_requests" ADD COLUMN     "decided_at" TIMESTAMPTZ(3),
ADD COLUMN     "decided_by_id" UUID,
ADD COLUMN     "internal_note" VARCHAR(1000),
ADD COLUMN     "reject_reason_code" VARCHAR(20),
ADD COLUMN     "routed_at" TIMESTAMPTZ(3),
ADD COLUMN     "routed_by_id" UUID;

-- CreateTable
CREATE TABLE "cs_reject_reasons" (
    "code" VARCHAR(20) NOT NULL,
    "text_ar" VARCHAR(300) NOT NULL,
    "text_en" VARCHAR(300) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cs_reject_reasons_pkey" PRIMARY KEY ("code")
);

-- AddForeignKey
ALTER TABLE "cs_booking_requests" ADD CONSTRAINT "cs_booking_requests_routed_by_id_fkey" FOREIGN KEY ("routed_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cs_booking_requests" ADD CONSTRAINT "cs_booking_requests_decided_by_id_fkey" FOREIGN KEY ("decided_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cs_booking_requests" ADD CONSTRAINT "cs_booking_requests_reject_reason_code_fkey" FOREIGN KEY ("reject_reason_code") REFERENCES "cs_reject_reasons"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The first reasons (docs/plans/04a section 4); the Administrator adds and edits the rest.
INSERT INTO "cs_reject_reasons" ("code", "text_ar", "text_en") VALUES
    ('ROUTE_UNAVAILABLE', 'الطريق ده ما متاح حالياً', 'This route is not available at the moment'),
    ('NEED_MORE_INFO', 'محتاجين معلومات أكتر، حنتواصل معاك', 'We need more information and will contact you'),
    ('DUPLICATE', 'الطلب ده مكرر', 'This request is a duplicate');
