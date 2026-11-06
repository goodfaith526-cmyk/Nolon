-- AlterTable
ALTER TABLE "cs_customer_tokens" ADD COLUMN     "channel" VARCHAR(20) NOT NULL DEFAULT 'whatsapp',
ADD COLUMN     "sender_hash" CHAR(64);
