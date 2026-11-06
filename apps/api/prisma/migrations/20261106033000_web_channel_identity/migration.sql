-- Owner, 2026-11-06: website chat visitors as a third signed channel (WEB, `web` + 16 hex).
-- Widens the subject check only: every existing row still matches; nothing is rewritten.
ALTER TABLE "customer_channel_identities" DROP CONSTRAINT "customer_channel_identity_subject_check";
ALTER TABLE "customer_channel_identities" ADD CONSTRAINT "customer_channel_identity_subject_check"
  CHECK (("channel" = 'WHATSAPP' AND "subject_id" ~ '^\+[1-9][0-9]{5,14}$')
      OR ("channel" = 'TELEGRAM' AND "subject_id" ~ '^[1-9][0-9]{0,31}$')
      OR ("channel" = 'WEB' AND "subject_id" ~ '^web[0-9a-f]{16}$'));
