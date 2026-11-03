-- Codex F171-2: the shipping terms and cargo an estimate prices, so approval books exactly those.
ALTER TABLE "cs_booking_requests" ADD COLUMN "estimate_terms" JSONB;
