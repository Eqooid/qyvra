CREATE TABLE "categories" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "color" VARCHAR(7),
    "icon" VARCHAR(50),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "categories_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "categories_name_valid" CHECK (
        char_length("name") BETWEEN 1 AND 100 AND "name" = btrim("name")
        AND "name" !~ '[[:cntrl:]]' AND position('  ' in "name") = 0
    ),
    CONSTRAINT "categories_color_valid" CHECK ("color" IS NULL OR "color" ~ '^#[0-9a-f]{6}$'),
    CONSTRAINT "categories_icon_valid" CHECK ("icon" IS NULL OR "icon" ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$'),
    CONSTRAINT "categories_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE INDEX "categories_user_id_id_idx" ON "categories"("user_id", "id");
-- Prisma cannot describe expression indexes: retain this unique owner/name invariant in migration history.
CREATE UNIQUE INDEX "categories_user_id_name_ci_key" ON "categories"("user_id", lower("name"));
