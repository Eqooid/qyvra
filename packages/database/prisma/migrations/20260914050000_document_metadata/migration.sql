-- CreateTable
CREATE TABLE "documents" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "category_id" UUID,
    "title" VARCHAR(300) NOT NULL,
    "document_type" VARCHAR(50) NOT NULL DEFAULT 'OTHER',
    "status" VARCHAR(32) NOT NULL DEFAULT 'UPLOADED',
    "issuer" VARCHAR(200),
    "reference_number" VARCHAR(200),
    "document_date" DATE,
    "expiration_date" DATE,
    "verified_summary" VARCHAR(10000),
    "is_archived" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "documents_pkey" PRIMARY KEY ("id")
);

-- Keep status/type extensible strings; enforce lifecycle consistency and metadata invariants.
ALTER TABLE "documents"
  ADD CONSTRAINT "documents_archive_state_check" CHECK ("is_archived" = ("status" = 'ARCHIVED')),
  ADD CONSTRAINT "documents_dates_check" CHECK ("document_date" IS NULL OR "expiration_date" IS NULL OR "expiration_date" >= "document_date"),
  ADD CONSTRAINT "documents_title_check" CHECK (char_length("title") > 0 AND "title" = btrim("title") AND "title" !~ '[[:cntrl:]]'),
  ADD CONSTRAINT "documents_type_check" CHECK ("document_type" ~ '^[A-Z][A-Z0-9_]{0,49}$'),
  ADD CONSTRAINT "documents_status_check" CHECK ("status" ~ '^[A-Z][A-Z0-9_]{0,31}$');

-- CreateTable
CREATE TABLE "document_tags" (
    "document_id" UUID NOT NULL,
    "tag_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_tags_pkey" PRIMARY KEY ("document_id","tag_id")
);

-- CreateIndex
CREATE INDEX "documents_user_id_created_at_id_idx" ON "documents"("user_id", "created_at", "id");

-- CreateIndex
CREATE INDEX "documents_user_id_status_document_date_idx" ON "documents"("user_id", "status", "document_date");

-- CreateIndex
CREATE INDEX "documents_user_id_category_id_idx" ON "documents"("user_id", "category_id");

-- CreateIndex
CREATE UNIQUE INDEX "documents_id_user_id_key" ON "documents"("id", "user_id");

-- CreateIndex
CREATE INDEX "document_tags_user_id_tag_id_document_id_idx" ON "document_tags"("user_id", "tag_id", "document_id");

-- CreateIndex
CREATE UNIQUE INDEX "tags_id_user_id_key" ON "tags"("id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "categories_id_user_id_key" ON "categories"("id", "user_id");

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_category_id_user_id_fkey" FOREIGN KEY ("category_id", "user_id") REFERENCES "categories"("id", "user_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "document_tags" ADD CONSTRAINT "document_tags_document_id_user_id_fkey" FOREIGN KEY ("document_id", "user_id") REFERENCES "documents"("id", "user_id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "document_tags" ADD CONSTRAINT "document_tags_tag_id_user_id_fkey" FOREIGN KEY ("tag_id", "user_id") REFERENCES "tags"("id", "user_id") ON DELETE CASCADE ON UPDATE RESTRICT;
