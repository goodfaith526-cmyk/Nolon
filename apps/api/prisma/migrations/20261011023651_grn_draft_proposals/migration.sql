-- CreateTable
CREATE TABLE "grn_draft_proposals" (
    "draft_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "lines" JSONB NOT NULL,
    "retain_until" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "grn_draft_proposals_pkey" PRIMARY KEY ("draft_id")
);

-- CreateIndex
CREATE INDEX "grn_draft_proposals_branch_id_idx" ON "grn_draft_proposals"("branch_id");

-- AddForeignKey
ALTER TABLE "grn_draft_proposals" ADD CONSTRAINT "grn_draft_proposals_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "grn_draft_proposals" ADD CONSTRAINT "grn_draft_proposals_lines_check" CHECK (
  jsonb_typeof("lines") = 'array'
);

-- The assistant's proposal is a record: once written it never changes, and it cannot be removed
-- before its retention ends (retain_until, the draft's expiry plus the retention period). After
-- that the retention purge removes it row by row; a bulk TRUNCATE is always refused.
CREATE FUNCTION "grn_draft_proposals_unchanged"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'The proposal of a GRN draft is kept as written'
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "grn_draft_proposals_unchanged"
  BEFORE UPDATE ON "grn_draft_proposals"
  FOR EACH ROW EXECUTE FUNCTION "grn_draft_proposals_unchanged"();

CREATE TRIGGER "grn_draft_proposals_no_truncate"
  BEFORE TRUNCATE ON "grn_draft_proposals"
  FOR EACH STATEMENT EXECUTE FUNCTION "grn_draft_proposals_unchanged"();

CREATE FUNCTION "grn_draft_proposals_retained"() RETURNS trigger AS $$
BEGIN
  IF OLD."retain_until" > CURRENT_TIMESTAMP THEN
    RAISE EXCEPTION 'The proposal of a GRN draft is kept until %', OLD."retain_until"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "grn_draft_proposals_retained"
  BEFORE DELETE ON "grn_draft_proposals"
  FOR EACH ROW EXECUTE FUNCTION "grn_draft_proposals_retained"();
