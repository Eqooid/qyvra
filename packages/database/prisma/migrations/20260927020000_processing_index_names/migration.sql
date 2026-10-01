-- PostgreSQL truncated two long generated names in the preceding migration.
-- Use stable short names that also match the Prisma schema.
ALTER INDEX "processing_jobs_user_id_document_id_document_version_id_created"
  RENAME TO "processing_jobs_owner_version_created_idx";

ALTER INDEX "processing_outbox_processing_job_id_event_type_dispatch_sequenc"
  RENAME TO "processing_outbox_job_type_sequence_key";
