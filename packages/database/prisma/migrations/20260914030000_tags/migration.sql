CREATE TABLE "tags" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "tags_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "tags_name_valid" CHECK (
        char_length("name") BETWEEN 1 AND 100 AND "name" = btrim("name")
        AND "name" !~ '[[:cntrl:]]' AND position('  ' in "name") = 0
    ),
    CONSTRAINT "tags_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX "tags_user_id_id_idx" ON "tags"("user_id", "id");
-- Matches Categories. Prisma cannot represent this expression index; preserve the migration SQL.
CREATE UNIQUE INDEX "tags_user_id_name_ci_key" ON "tags"("user_id", lower("name"));
