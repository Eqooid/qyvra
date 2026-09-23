-- Preserve existing creation receipts while separating each document's version-upload keys.
ALTER TABLE "document_uploads" ADD COLUMN "scope" VARCHAR(64) NOT NULL DEFAULT 'create';
ALTER TABLE "document_uploads" DROP CONSTRAINT "document_uploads_pkey";
ALTER TABLE "document_uploads" ADD CONSTRAINT "document_uploads_pkey" PRIMARY KEY ("user_id", "scope", "key");
ALTER TABLE "document_uploads" ADD CONSTRAINT "document_uploads_scope_check"
CHECK ("scope" = 'create' OR "scope" ~ '^versions:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$');
