-- CreateTable
CREATE TABLE "document_versions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "document_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "version_number" INTEGER NOT NULL,
    "original_filename" VARCHAR(255) NOT NULL,
    "storage_key" VARCHAR(512) NOT NULL,
    "mime_type" VARCHAR(100) NOT NULL,
    "file_size" INTEGER NOT NULL,
    "checksum_sha256" VARCHAR(64) NOT NULL,
    "page_count" INTEGER,
    "extraction_status" VARCHAR(32) NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_uploads" (
    "user_id" UUID NOT NULL,
    "key" UUID NOT NULL,
    "attempt_id" UUID NOT NULL,
    "state" VARCHAR(16) NOT NULL DEFAULT 'RECEIVING',
    "fingerprint" VARCHAR(64),
    "document_id" UUID,
    "response" JSONB,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_uploads_pkey" PRIMARY KEY ("user_id","key")
);

-- CreateIndex
CREATE UNIQUE INDEX "document_versions_storage_key_key" ON "document_versions"("storage_key");

-- CreateIndex
CREATE INDEX "document_versions_checksum_sha256_idx" ON "document_versions"("checksum_sha256");

-- CreateIndex
CREATE INDEX "document_versions_document_id_created_at_id_idx" ON "document_versions"("document_id", "created_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "document_versions_document_id_version_number_key" ON "document_versions"("document_id", "version_number");

-- CreateIndex
CREATE UNIQUE INDEX "document_versions_user_id_checksum_sha256_key" ON "document_versions"("user_id", "checksum_sha256");

-- CreateIndex
CREATE INDEX "document_uploads_expires_at_idx" ON "document_uploads"("expires_at");

-- AddForeignKey
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_document_id_user_id_fkey" FOREIGN KEY ("document_id", "user_id") REFERENCES "documents"("id", "user_id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "document_uploads" ADD CONSTRAINT "document_uploads_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE document_versions
  ADD CONSTRAINT document_versions_values_check CHECK (version_number > 0 AND file_size > 0 AND file_size <= 209715200 AND checksum_sha256 ~ '^[0-9a-f]{64}$' AND (page_count IS NULL OR page_count > 0)),
  ADD CONSTRAINT document_versions_media_check CHECK (mime_type IN ('application/pdf', 'image/jpeg', 'image/png') AND ((mime_type = 'application/pdf' AND page_count IS NOT NULL) OR (mime_type <> 'application/pdf' AND page_count IS NULL)));
ALTER TABLE document_uploads ADD CONSTRAINT document_upload_state_check CHECK (
  (state = 'RECEIVING' AND fingerprint IS NULL AND document_id IS NULL AND response IS NULL) OR
  (state = 'COMPLETED' AND fingerprint ~ '^[0-9a-f]{64}$' AND document_id IS NOT NULL AND response IS NOT NULL)
);
CREATE FUNCTION protect_document_version_original() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id, NEW.document_id, NEW.user_id, NEW.version_number, NEW.original_filename, NEW.storage_key, NEW.mime_type, NEW.file_size, NEW.checksum_sha256, NEW.page_count, NEW.created_at)
     IS DISTINCT FROM ROW(OLD.id, OLD.document_id, OLD.user_id, OLD.version_number, OLD.original_filename, OLD.storage_key, OLD.mime_type, OLD.file_size, OLD.checksum_sha256, OLD.page_count, OLD.created_at) THEN
    RAISE EXCEPTION 'Original document version metadata is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER document_version_original_immutable BEFORE UPDATE ON document_versions FOR EACH ROW EXECUTE FUNCTION protect_document_version_original();
