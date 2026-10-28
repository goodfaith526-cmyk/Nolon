-- CreateTable
CREATE TABLE "branch_routing_rules" (
    "location_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "branch_routing_rules_pkey" PRIMARY KEY ("location_id","branch_id")
);

-- CreateIndex
CREATE INDEX "branch_routing_rules_branch_id_idx" ON "branch_routing_rules"("branch_id");

-- AddForeignKey
ALTER TABLE "branch_routing_rules" ADD CONSTRAINT "branch_routing_rules_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branch_routing_rules" ADD CONSTRAINT "branch_routing_rules_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
