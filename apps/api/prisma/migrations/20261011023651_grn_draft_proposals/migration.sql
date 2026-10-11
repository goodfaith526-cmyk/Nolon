-- CreateTable
CREATE TABLE "grn_draft_proposals" (
    "draft_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "lines" JSONB NOT NULL,
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

-- The assistant's proposal is a record: once written it never changes and is never removed.
CREATE FUNCTION "grn_draft_proposals_kept"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'The proposal of a GRN draft is kept as written'
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "grn_draft_proposals_kept"
  BEFORE UPDATE OR DELETE ON "grn_draft_proposals"
  FOR EACH ROW EXECUTE FUNCTION "grn_draft_proposals_kept"();

CREATE TRIGGER "grn_draft_proposals_kept_truncate"
  BEFORE TRUNCATE ON "grn_draft_proposals"
  FOR EACH STATEMENT EXECUTE FUNCTION "grn_draft_proposals_kept"();
