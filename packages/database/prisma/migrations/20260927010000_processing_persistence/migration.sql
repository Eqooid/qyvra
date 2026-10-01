-- Add a composite target for version-scoped, owner-checked processing jobs.
-- The original immutable version columns and their existing constraints are unchanged.
CREATE UNIQUE INDEX "document_versions_id_document_id_user_id_key"
  ON "document_versions"("id", "document_id", "user_id");

CREATE TABLE "processing_jobs" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "user_id" UUID NOT NULL,
  "document_id" UUID NOT NULL,
  "document_version_id" UUID NOT NULL,
  "job_type" VARCHAR(64) NOT NULL,
  "generation" INTEGER NOT NULL DEFAULT 1,
  "status" VARCHAR(16) NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "max_attempts" INTEGER NOT NULL,
  "available_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lease_token" UUID,
  "lease_expires_at" TIMESTAMPTZ(3),
  "heartbeat_at" TIMESTAMPTZ(3),
  "started_at" TIMESTAMPTZ(3),
  "completed_at" TIMESTAMPTZ(3),
  "last_failure_code" VARCHAR(64),
  "correlation_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "processing_jobs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "processing_jobs_job_type_check"
    CHECK ("job_type" ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  CONSTRAINT "processing_jobs_status_check"
    CHECK ("status" IN ('PENDING', 'QUEUED', 'PROCESSING', 'RETRYING', 'COMPLETED', 'FAILED', 'CANCELLED')),
  CONSTRAINT "processing_jobs_attempts_check"
    CHECK ("generation" > 0 AND "max_attempts" BETWEEN 1 AND 100
      AND "attempts" BETWEEN 0 AND "max_attempts"),
  CONSTRAINT "processing_jobs_failure_code_check"
    CHECK ("last_failure_code" IS NULL OR "last_failure_code" ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  CONSTRAINT "processing_jobs_lease_check" CHECK (
    ("lease_token" IS NULL) = ("lease_expires_at" IS NULL)
    AND (("status" = 'PROCESSING') = ("lease_token" IS NOT NULL))
    AND ("status" <> 'PROCESSING' OR ("attempts" > 0 AND "started_at" IS NOT NULL))
    AND ("heartbeat_at" IS NULL OR "status" = 'PROCESSING')
  ),
  CONSTRAINT "processing_jobs_completion_check" CHECK (
    (("status" IN ('COMPLETED', 'FAILED', 'CANCELLED')) = ("completed_at" IS NOT NULL))
    AND ("completed_at" IS NULL OR "started_at" IS NULL OR "completed_at" >= "started_at")
  )
);

CREATE UNIQUE INDEX "processing_jobs_document_version_id_job_type_generation_key"
  ON "processing_jobs"("document_version_id", "job_type", "generation");
-- A later generation may start after a terminal one; never run two active equivalents.
CREATE UNIQUE INDEX "processing_jobs_one_active_version_type_key"
  ON "processing_jobs"("document_version_id", "job_type")
  WHERE "status" IN ('PENDING', 'QUEUED', 'PROCESSING', 'RETRYING');
CREATE INDEX "processing_jobs_user_id_document_id_document_version_id_created_at_idx"
  ON "processing_jobs"("user_id", "document_id", "document_version_id", "created_at");
CREATE INDEX "processing_jobs_status_available_at_id_idx"
  ON "processing_jobs"("status", "available_at", "id");
CREATE INDEX "processing_jobs_status_lease_expires_at_idx"
  ON "processing_jobs"("status", "lease_expires_at");

ALTER TABLE "processing_jobs"
  ADD CONSTRAINT "processing_jobs_document_id_user_id_fkey"
    FOREIGN KEY ("document_id", "user_id") REFERENCES "documents"("id", "user_id")
    ON DELETE CASCADE ON UPDATE RESTRICT,
  ADD CONSTRAINT "processing_jobs_document_version_id_document_id_user_id_fkey"
    FOREIGN KEY ("document_version_id", "document_id", "user_id")
    REFERENCES "document_versions"("id", "document_id", "user_id")
    ON DELETE CASCADE ON UPDATE RESTRICT;

CREATE TABLE "processing_outbox" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "processing_job_id" UUID NOT NULL,
  "event_type" VARCHAR(64) NOT NULL,
  "schema_version" INTEGER NOT NULL,
  "dispatch_sequence" INTEGER NOT NULL,
  "payload" JSONB NOT NULL,
  "status" VARCHAR(16) NOT NULL DEFAULT 'PENDING',
  "publication_attempts" INTEGER NOT NULL DEFAULT 0,
  "available_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "claim_token" UUID,
  "claim_expires_at" TIMESTAMPTZ(3),
  "published_at" TIMESTAMPTZ(3),
  "last_failure_code" VARCHAR(64),
  "occurred_at" TIMESTAMPTZ(3) NOT NULL,
  "correlation_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "processing_outbox_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "processing_outbox_event_type_check"
    CHECK ("event_type" ~ '^[a-z][a-z0-9.]{0,63}$'),
  CONSTRAINT "processing_outbox_numbers_check"
    CHECK ("schema_version" BETWEEN 1 AND 65535 AND "dispatch_sequence" > 0
      AND "publication_attempts" >= 0),
  CONSTRAINT "processing_outbox_status_check"
    CHECK ("status" IN ('PENDING', 'PUBLISHED')
      AND (("status" = 'PUBLISHED') = ("published_at" IS NOT NULL))
      AND ("status" <> 'PUBLISHED' OR "publication_attempts" > 0)),
  CONSTRAINT "processing_outbox_claim_check"
    CHECK (("claim_token" IS NULL) = ("claim_expires_at" IS NULL)
      AND ("status" <> 'PUBLISHED' OR "claim_token" IS NULL)),
  CONSTRAINT "processing_outbox_failure_code_check"
    CHECK ("last_failure_code" IS NULL OR "last_failure_code" ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  CONSTRAINT "processing_outbox_payload_check" CHECK (
    jsonb_typeof("payload") = 'object'
    AND "payload" ?& ARRAY['schemaVersion', 'messageId', 'type', 'occurredAt',
      'correlationId', 'jobId', 'documentId', 'documentVersionId', 'jobType', 'dispatchSequence']
    AND "payload"->>'messageId' = "id"::text
    AND "payload"->>'jobId' = "processing_job_id"::text
    AND "payload"->>'type' = "event_type"
    AND "payload"->>'schemaVersion' = "schema_version"::text
    AND "payload"->>'dispatchSequence' = "dispatch_sequence"::text
    AND "payload"->>'correlationId' = "correlation_id"::text
  )
);

CREATE UNIQUE INDEX "processing_outbox_processing_job_id_event_type_dispatch_sequence_key"
  ON "processing_outbox"("processing_job_id", "event_type", "dispatch_sequence");
CREATE INDEX "processing_outbox_status_available_at_id_idx"
  ON "processing_outbox"("status", "available_at", "id");
CREATE INDEX "processing_outbox_status_claim_expires_at_idx"
  ON "processing_outbox"("status", "claim_expires_at");

ALTER TABLE "processing_outbox"
  ADD CONSTRAINT "processing_outbox_processing_job_id_fkey"
    FOREIGN KEY ("processing_job_id") REFERENCES "processing_jobs"("id")
    ON DELETE CASCADE ON UPDATE RESTRICT;
