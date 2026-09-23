-- PostgreSQL CHECK accepts UNKNOWN: explicitly require a fingerprint for completed uploads.
ALTER TABLE "document_uploads" ADD CONSTRAINT "document_uploads_completed_fingerprint"
CHECK ("state" <> 'COMPLETED' OR "fingerprint" IS NOT NULL);
