-- CreateTable
CREATE TABLE "location_aliases" (
    "location_id" UUID NOT NULL,
    "alias" VARCHAR(100) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "location_aliases_pkey" PRIMARY KEY ("location_id","alias")
);

-- AddForeignKey
ALTER TABLE "location_aliases" ADD CONSTRAINT "location_aliases_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
