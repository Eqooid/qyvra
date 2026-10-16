-- Additive T02 foundation: no state initialization, enrollment or remote I/O.
BEGIN;

-- AlterTable
ALTER TABLE "processing_jobs" ADD COLUMN     "search_projection_id" UUID;

-- CreateTable
CREATE TABLE "search_index_generations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "generation" INTEGER NOT NULL,
    "schema_version" INTEGER NOT NULL,
    "mapping_version" VARCHAR(100) NOT NULL,
    "analyzer_version" VARCHAR(100) NOT NULL,
    "extractor" VARCHAR(100) NOT NULL,
    "extractor_version" VARCHAR(100) NOT NULL,
    "normalization_version" VARCHAR(100) NOT NULL,
    "segmentation_version" VARCHAR(100) NOT NULL,
    "fingerprint" VARCHAR(64) NOT NULL,
    "metadata_index_name" VARCHAR(200) NOT NULL,
    "page_index_name" VARCHAR(200) NOT NULL,
    "status" VARCHAR(16) NOT NULL DEFAULT 'BUILDING',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "search_index_generations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_search_states" (
    "document_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "desired_version_id" UUID NOT NULL,
    "desired_revision" INTEGER NOT NULL DEFAULT 1,
    "ready_projection_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_search_states_pkey" PRIMARY KEY ("document_id")
);

-- CreateTable
CREATE TABLE "version_search_projections" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "document_version_id" UUID NOT NULL,
    "index_generation_id" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "extracted_text_id" UUID,
    "metadata_hash" VARCHAR(64) NOT NULL,
    "expected_record_ids" JSONB NOT NULL DEFAULT '[]',
    "expected_record_count" INTEGER NOT NULL DEFAULT 0,
    "records_hash" VARCHAR(64),
    "metadata_ready" BOOLEAN NOT NULL DEFAULT false,
    "text_coverage" VARCHAR(16) NOT NULL DEFAULT 'NOT_REQUESTED',
    "status" VARCHAR(16) NOT NULL DEFAULT 'BUILDING',
    "verified_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "version_search_projections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "search_projection_changes" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "reason" VARCHAR(32) NOT NULL,
    "resource_id" UUID NOT NULL,
    "after_document_id" UUID,
    "status" VARCHAR(16) NOT NULL DEFAULT 'PENDING',
    "completed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "search_projection_changes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "search_index_generations_generation_key" ON "search_index_generations"("generation");

-- CreateIndex
CREATE UNIQUE INDEX "search_index_generations_fingerprint_key" ON "search_index_generations"("fingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "search_index_generations_metadata_index_name_key" ON "search_index_generations"("metadata_index_name");

-- CreateIndex
CREATE UNIQUE INDEX "search_index_generations_page_index_name_key" ON "search_index_generations"("page_index_name");

-- CreateIndex
CREATE INDEX "document_search_states_user_id_desired_version_id_idx" ON "document_search_states"("user_id", "desired_version_id");

-- CreateIndex
CREATE INDEX "document_search_states_ready_projection_id_idx" ON "document_search_states"("ready_projection_id");

-- CreateIndex
CREATE UNIQUE INDEX "document_search_states_document_id_user_id_key" ON "document_search_states"("document_id", "user_id");

-- CreateIndex
CREATE INDEX "version_search_projections_user_id_document_id_document_ver_idx" ON "version_search_projections"("user_id", "document_id", "document_version_id");

-- CreateIndex
CREATE INDEX "version_search_projections_index_generation_id_status_id_idx" ON "version_search_projections"("index_generation_id", "status", "id");

-- CreateIndex
CREATE UNIQUE INDEX "search_projection_version_generation_revision_key" ON "version_search_projections"("document_version_id", "index_generation_id", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "search_projection_owned_identity_key" ON "version_search_projections"("id", "document_version_id", "document_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "search_projection_owned_revision_key" ON "version_search_projections"("id", "document_version_id", "document_id", "user_id", "revision");

-- CreateIndex
CREATE INDEX "search_projection_changes_status_updated_at_id_idx" ON "search_projection_changes"("status", "updated_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "search_projection_change_owner_reason_resource_key" ON "search_projection_changes"("user_id", "reason", "resource_id");

-- CreateIndex
CREATE INDEX "processing_jobs_search_projection_type_idx" ON "processing_jobs"("search_projection_id", "job_type");

-- AddForeignKey
ALTER TABLE "processing_jobs" ADD CONSTRAINT "processing_jobs_search_projection_id_document_version_id_d_fkey" FOREIGN KEY ("search_projection_id", "document_version_id", "document_id", "user_id") REFERENCES "version_search_projections"("id", "document_version_id", "document_id", "user_id") ON DELETE NO ACTION ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "document_search_states" ADD CONSTRAINT "document_search_states_document_id_user_id_fkey" FOREIGN KEY ("document_id", "user_id") REFERENCES "documents"("id", "user_id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "document_search_states" ADD CONSTRAINT "document_search_states_desired_version_id_document_id_user_fkey" FOREIGN KEY ("desired_version_id", "document_id", "user_id") REFERENCES "document_versions"("id", "document_id", "user_id") ON DELETE NO ACTION ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "document_search_states" ADD CONSTRAINT "document_search_states_ready_projection_id_desired_version_fkey" FOREIGN KEY ("ready_projection_id", "desired_version_id", "document_id", "user_id", "desired_revision") REFERENCES "version_search_projections"("id", "document_version_id", "document_id", "user_id", "revision") ON DELETE NO ACTION ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "version_search_projections" ADD CONSTRAINT "version_search_projections_document_version_id_document_id_fkey" FOREIGN KEY ("document_version_id", "document_id", "user_id") REFERENCES "document_versions"("id", "document_id", "user_id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "version_search_projections" ADD CONSTRAINT "version_search_projections_index_generation_id_fkey" FOREIGN KEY ("index_generation_id") REFERENCES "search_index_generations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "version_search_projections" ADD CONSTRAINT "version_search_projections_extracted_text_id_document_vers_fkey" FOREIGN KEY ("extracted_text_id", "document_version_id", "document_id", "user_id") REFERENCES "extracted_texts"("id", "document_version_id", "document_id", "user_id") ON DELETE NO ACTION ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "search_projection_changes" ADD CONSTRAINT "search_projection_changes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- SQL-only invariants, consistent with the existing processing/artifact approach.
ALTER TABLE search_index_generations ADD CONSTRAINT search_generation_config_check CHECK (
  generation > 0 AND schema_version > 0 AND fingerprint ~ '^[0-9a-f]{64}$'
  AND mapping_version ~ '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$'
  AND analyzer_version ~ '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$'
  AND extractor ~ '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$'
  AND extractor_version ~ '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$'
  AND normalization_version ~ '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$'
  AND segmentation_version ~ '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$'
  AND metadata_index_name ~ '^qyvra-search-[a-z0-9][a-z0-9_-]{0,180}$'
  AND page_index_name ~ '^qyvra-search-[a-z0-9][a-z0-9_-]{0,180}$'
  AND metadata_index_name <> page_index_name
  AND status IN ('BUILDING','SERVING','RETIRED'));
CREATE UNIQUE INDEX search_generation_one_serving_key ON search_index_generations(status)
  WHERE status = 'SERVING';

CREATE FUNCTION search_guard_generation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE canonical text;
BEGIN
  canonical := '[' || array_to_string(ARRAY[
    to_json('qyvra.search-generation.v1'::text)::text, to_json(NEW.schema_version)::text,
    to_json(NEW.mapping_version)::text, to_json(NEW.analyzer_version)::text,
    to_json(NEW.extractor)::text, to_json(NEW.extractor_version)::text,
    to_json(NEW.normalization_version)::text, to_json(NEW.segmentation_version)::text], ',') || ']';
  IF NEW.fingerprint IS DISTINCT FROM encode(sha256(convert_to(canonical,'UTF8')),'hex') THEN
    RAISE EXCEPTION 'Search generation fingerprint mismatch' USING ERRCODE='23514';
  END IF;
  IF TG_OP='INSERT' AND NEW.status <> 'BUILDING' THEN
    RAISE EXCEPTION 'New search generation must be building' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' THEN
    IF (to_jsonb(NEW)-ARRAY['status','updated_at']) IS DISTINCT FROM
       (to_jsonb(OLD)-ARRAY['status','updated_at']) THEN
      RAISE EXCEPTION 'Immutable search generation configuration' USING ERRCODE='23514';
    END IF;
    IF NEW.status <> OLD.status AND NOT (
      (OLD.status='BUILDING' AND NEW.status IN ('SERVING','RETIRED')) OR
      (OLD.status='SERVING' AND NEW.status='RETIRED')) THEN
      RAISE EXCEPTION 'Invalid search generation transition' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER search_generation_guard BEFORE INSERT OR UPDATE ON search_index_generations
  FOR EACH ROW EXECUTE FUNCTION search_guard_generation();

ALTER TABLE document_search_states ADD CONSTRAINT search_state_revision_check CHECK (desired_revision > 0);
ALTER TABLE version_search_projections ADD CONSTRAINT search_projection_manifest_check CHECK (
  revision > 0 AND metadata_hash ~ '^[0-9a-f]{64}$'
  AND status IN ('BUILDING','READY','REMOVAL_PENDING','REMOVED','FAILED')
  AND text_coverage IN ('NOT_REQUESTED','PENDING','READY','UNSUPPORTED','FAILED')
  AND (text_coverage <> 'READY' OR extracted_text_id IS NOT NULL)
  AND jsonb_typeof(expected_record_ids)='array'
  AND expected_record_count BETWEEN 0 AND 10000
  AND expected_record_count=jsonb_array_length(expected_record_ids)
  AND octet_length(expected_record_ids::text) <= 1048576
  AND (records_hash IS NULL OR records_hash ~ '^[0-9a-f]{64}$')
  AND (status <> 'READY' OR (metadata_ready AND expected_record_count > 0
    AND records_hash IS NOT NULL AND verified_at IS NOT NULL)));

CREATE FUNCTION search_guard_state() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d documents; p version_search_projections;
BEGIN
  SELECT * INTO d FROM documents WHERE id=NEW.document_id AND user_id=NEW.user_id FOR UPDATE;
  IF TG_OP='UPDATE' THEN
    IF (NEW.document_id,NEW.user_id,NEW.created_at) IS DISTINCT FROM
       (OLD.document_id,OLD.user_id,OLD.created_at) OR
       NEW.desired_revision < OLD.desired_revision OR
       NEW.desired_revision > OLD.desired_revision+1::bigint OR
       (NEW.desired_version_id <> OLD.desired_version_id AND NEW.desired_revision=OLD.desired_revision) OR
       (NEW.desired_revision <> OLD.desired_revision AND NEW.ready_projection_id IS NOT NULL) THEN
      RAISE EXCEPTION 'Invalid search desired revision transition' USING ERRCODE='23514';
    END IF;
  END IF;
  -- T03 owns lifecycle revocation. T02 rejects new stale publication, without
  -- adding triggers to existing document/upload mutation behavior.
  IF TG_OP='INSERT' OR NEW.desired_version_id IS DISTINCT FROM OLD.desired_version_id
    OR NEW.ready_projection_id IS NOT NULL THEN
    IF d.id IS NULL OR d.deleted_at IS NOT NULL OR d.is_archived OR d.status IN ('ARCHIVED','DELETING')
      OR NOT EXISTS (SELECT 1 FROM document_versions v WHERE v.id=NEW.desired_version_id
        AND v.document_id=NEW.document_id AND v.user_id=NEW.user_id
        AND NOT EXISTS (SELECT 1 FROM document_versions n WHERE n.document_id=v.document_id
          AND n.version_number>v.version_number)) THEN
      RAISE EXCEPTION 'Ineligible search version' USING ERRCODE='23514';
    END IF;
  END IF;
  IF NEW.ready_projection_id IS NOT NULL THEN
    SELECT * INTO p FROM version_search_projections WHERE id=NEW.ready_projection_id;
    IF p.status IS DISTINCT FROM 'READY' OR p.document_id IS DISTINCT FROM NEW.document_id
      OR p.user_id IS DISTINCT FROM NEW.user_id OR p.document_version_id IS DISTINCT FROM NEW.desired_version_id
      OR p.revision IS DISTINCT FROM NEW.desired_revision
      OR NOT EXISTS (SELECT 1 FROM search_index_generations g WHERE g.id=p.index_generation_id AND g.status='SERVING') THEN
      RAISE EXCEPTION 'Invalid search ready publication' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER search_state_guard BEFORE INSERT OR UPDATE ON document_search_states
  FOR EACH ROW EXECUTE FUNCTION search_guard_state();

CREATE FUNCTION search_guard_projection() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE record jsonb; e extracted_texts; g search_index_generations; d documents;
BEGIN
  SELECT * INTO d FROM documents WHERE id=NEW.document_id AND user_id=NEW.user_id FOR UPDATE;
  SELECT * INTO g FROM search_index_generations WHERE id=NEW.index_generation_id;
  IF TG_OP='INSERT' AND NEW.status <> 'BUILDING' THEN
    RAISE EXCEPTION 'New search projection must be building' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' THEN
    IF (NEW.id,NEW.user_id,NEW.document_id,NEW.document_version_id,NEW.index_generation_id,
        NEW.revision,NEW.metadata_hash,NEW.created_at) IS DISTINCT FROM
       (OLD.id,OLD.user_id,OLD.document_id,OLD.document_version_id,OLD.index_generation_id,
        OLD.revision,OLD.metadata_hash,OLD.created_at) THEN
      RAISE EXCEPTION 'Immutable search projection identity' USING ERRCODE='23514';
    END IF;
    IF OLD.status <> 'BUILDING' AND (to_jsonb(NEW)-ARRAY['status','updated_at']) IS DISTINCT FROM
       (to_jsonb(OLD)-ARRAY['status','updated_at']) THEN
      RAISE EXCEPTION 'Immutable published search manifest' USING ERRCODE='23514';
    END IF;
    IF NEW.status <> OLD.status AND NOT (
      (OLD.status='BUILDING' AND NEW.status IN ('READY','FAILED','REMOVAL_PENDING')) OR
      (OLD.status IN ('READY','FAILED') AND NEW.status='REMOVAL_PENDING') OR
      (OLD.status='REMOVAL_PENDING' AND NEW.status='REMOVED')) THEN
      RAISE EXCEPTION 'Invalid search projection transition' USING ERRCODE='23514';
    END IF;
    IF NEW.status <> 'READY' AND EXISTS (
      SELECT 1 FROM document_search_states WHERE ready_projection_id=NEW.id) THEN
      RAISE EXCEPTION 'Revoke search pointer before retirement' USING ERRCODE='23514';
    END IF;
  END IF;
  IF jsonb_typeof(NEW.expected_record_ids) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Invalid search record manifest' USING ERRCODE='23514';
  END IF;
  FOR record IN SELECT value FROM jsonb_array_elements(NEW.expected_record_ids) LOOP
    IF jsonb_typeof(record) <> 'string' OR (record#>>'{}') !~
      ('^'||NEW.id::text||':(metadata|page:[1-9][0-9]{0,9}:(0|[1-9][0-9]{0,9}))$') THEN
      RAISE EXCEPTION 'Invalid search record identity' USING ERRCODE='23514';
    END IF;
  END LOOP;
  IF (SELECT count(DISTINCT value) FROM jsonb_array_elements(NEW.expected_record_ids)) <
      jsonb_array_length(NEW.expected_record_ids) THEN
    RAISE EXCEPTION 'Duplicate search record identity' USING ERRCODE='23514';
  END IF;
  IF NEW.extracted_text_id IS NOT NULL THEN
    SELECT * INTO e FROM extracted_texts WHERE id=NEW.extracted_text_id;
    IF e.user_id IS DISTINCT FROM NEW.user_id OR e.document_id IS DISTINCT FROM NEW.document_id
      OR e.document_version_id IS DISTINCT FROM NEW.document_version_id
      OR e.extractor IS DISTINCT FROM g.extractor OR e.extractor_version IS DISTINCT FROM g.extractor_version
      OR e.normalization_version IS DISTINCT FROM g.normalization_version
      OR e.source_checksum IS DISTINCT FROM (SELECT checksum_sha256 FROM document_versions WHERE id=NEW.document_version_id) THEN
      RAISE EXCEPTION 'Invalid search canonical extraction' USING ERRCODE='23514';
    END IF;
  END IF;
  IF TG_OP='INSERT' OR (NEW.status='READY' AND OLD.status IS DISTINCT FROM 'READY') THEN
    IF d.id IS NULL OR d.deleted_at IS NOT NULL OR d.is_archived OR d.status IN ('ARCHIVED','DELETING')
      OR g.status NOT IN ('BUILDING','SERVING')
      OR NOT EXISTS (SELECT 1 FROM document_search_states s WHERE s.document_id=NEW.document_id
        AND s.user_id=NEW.user_id AND s.desired_version_id=NEW.document_version_id AND s.desired_revision=NEW.revision)
      OR EXISTS (SELECT 1 FROM document_versions n JOIN document_versions v ON v.id=NEW.document_version_id
        WHERE n.document_id=v.document_id AND n.version_number>v.version_number) THEN
      RAISE EXCEPTION 'Stale search projection' USING ERRCODE='23514';
    END IF;
    IF NEW.status='READY' AND NOT (NEW.expected_record_ids ? (NEW.id::text||':metadata')) THEN
      RAISE EXCEPTION 'Search manifest lacks metadata record' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER search_projection_guard BEFORE INSERT OR UPDATE ON version_search_projections
  FOR EACH ROW EXECUTE FUNCTION search_guard_projection();

ALTER TABLE search_projection_changes ADD CONSTRAINT search_change_state_check CHECK (
  reason IN ('CATEGORY_DELETED','TAG_DELETED') AND status IN ('PENDING','COMPLETED')
  AND ((status='COMPLETED')=(completed_at IS NOT NULL)));
CREATE FUNCTION search_guard_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id,NEW.user_id,NEW.reason,NEW.resource_id,NEW.created_at) IS DISTINCT FROM
     (OLD.id,OLD.user_id,OLD.reason,OLD.resource_id,OLD.created_at)
    OR (OLD.after_document_id IS NOT NULL AND
      (NEW.after_document_id IS NULL OR NEW.after_document_id<OLD.after_document_id))
    OR (OLD.status='COMPLETED' AND NEW IS DISTINCT FROM OLD) THEN
    RAISE EXCEPTION 'Invalid search fanout checkpoint transition' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER search_change_guard BEFORE UPDATE ON search_projection_changes
  FOR EACH ROW EXECUTE FUNCTION search_guard_change();

ALTER TABLE processing_jobs ADD CONSTRAINT processing_jobs_search_inputs_check CHECK (
  (job_type IN ('INDEX_SEARCH','EXTRACT_SEARCH_TEXT','REMOVE_SEARCH_INDEX'))=(search_projection_id IS NOT NULL)
  AND (search_projection_id IS NULL OR
    (ai_run_id IS NULL AND chunk_set_id IS NULL AND vector_index_id IS NULL
     AND (job_type='EXTRACT_SEARCH_TEXT' OR (predecessor_job_id IS NULL AND extracted_text_id IS NULL))))
  AND (job_type <> 'EXTRACT_SEARCH_TEXT' OR predecessor_job_id IS NOT NULL));

CREATE FUNCTION search_guard_job() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p version_search_projections; predecessor processing_jobs; e extracted_texts; g search_index_generations;
BEGIN
  IF TG_OP='UPDATE' AND OLD.search_projection_id IS NOT NULL AND NEW.search_projection_id IS NULL THEN
    RAISE EXCEPTION 'Immutable search processing identity' USING ERRCODE='23514';
  END IF;
  IF NEW.search_projection_id IS NULL THEN RETURN NEW; END IF;
  IF TG_OP='INSERT' AND NEW.status <> 'PENDING' THEN
    RAISE EXCEPTION 'New search job must be pending' USING ERRCODE='23514';
  END IF;
  SELECT * INTO p FROM version_search_projections WHERE id=NEW.search_projection_id;
  IF TG_OP='UPDATE' AND OLD.extracted_text_id IS NOT NULL AND
    NEW.extracted_text_id IS DISTINCT FROM OLD.extracted_text_id THEN
    RAISE EXCEPTION 'Immutable search extraction output' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' AND (NEW.search_projection_id,NEW.job_type,NEW.user_id,NEW.document_id,
      NEW.document_version_id,NEW.generation,NEW.correlation_id,NEW.predecessor_job_id) IS DISTINCT FROM
     (OLD.search_projection_id,OLD.job_type,OLD.user_id,OLD.document_id,
      OLD.document_version_id,OLD.generation,OLD.correlation_id,OLD.predecessor_job_id) THEN
    RAISE EXCEPTION 'Immutable search processing identity' USING ERRCODE='23514';
  END IF;
  IF NEW.job_type='EXTRACT_SEARCH_TEXT' THEN
    SELECT * INTO predecessor FROM processing_jobs WHERE id=NEW.predecessor_job_id;
    IF predecessor.job_type IS DISTINCT FROM 'VERIFY_STORED_FILE' OR predecessor.status IS DISTINCT FROM 'COMPLETED'
      OR predecessor.document_version_id IS DISTINCT FROM NEW.document_version_id
      OR predecessor.document_id IS DISTINCT FROM NEW.document_id OR predecessor.user_id IS DISTINCT FROM NEW.user_id
      OR (SELECT mime_type FROM document_versions WHERE id=NEW.document_version_id) IS DISTINCT FROM 'application/pdf' THEN
      RAISE EXCEPTION 'Search extraction requires verified PDF' USING ERRCODE='23514';
    END IF;
  END IF;
  IF NEW.status='COMPLETED' THEN
    IF (NEW.job_type='INDEX_SEARCH' AND p.status IS DISTINCT FROM 'READY') OR
       (NEW.job_type='REMOVE_SEARCH_INDEX' AND p.status IS DISTINCT FROM 'REMOVED') THEN
      RAISE EXCEPTION 'Search completion requires published artifact state' USING ERRCODE='23514';
    END IF;
    IF NEW.job_type='EXTRACT_SEARCH_TEXT' THEN
      SELECT * INTO e FROM extracted_texts WHERE id=NEW.extracted_text_id;
      SELECT * INTO g FROM search_index_generations WHERE id=p.index_generation_id;
      IF NEW.extracted_text_id IS NULL OR e.user_id IS DISTINCT FROM NEW.user_id
        OR e.document_version_id IS DISTINCT FROM NEW.document_version_id
        OR e.extractor IS DISTINCT FROM g.extractor OR e.extractor_version IS DISTINCT FROM g.extractor_version
        OR e.normalization_version IS DISTINCT FROM g.normalization_version
        OR e.source_checksum IS DISTINCT FROM (SELECT checksum_sha256 FROM document_versions WHERE id=NEW.document_version_id) THEN
        RAISE EXCEPTION 'Search extraction completion requires canonical artifact' USING ERRCODE='23514';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER search_job_guard BEFORE INSERT OR UPDATE ON processing_jobs
  FOR EACH ROW EXECUTE FUNCTION search_guard_job();

CREATE FUNCTION search_guard_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE j processing_jobs; p version_search_projections; expected jsonb;
BEGIN
  SELECT * INTO j FROM processing_jobs WHERE id=NEW.processing_job_id;
  IF j.search_projection_id IS NULL AND NEW.schema_version <> 3 THEN RETURN NEW; END IF;
  SELECT * INTO p FROM version_search_projections WHERE id=j.search_projection_id;
  expected := jsonb_build_object('schemaVersion',3,'messageId',NEW.id::text,
    'type','processing.execute','correlationId',j.correlation_id::text,'jobId',j.id::text,
    'documentId',j.document_id::text,'documentVersionId',j.document_version_id::text,
    'jobType',j.job_type,'dispatchSequence',NEW.dispatch_sequence,
    'searchProjectionId',p.id::text,'indexGenerationId',p.index_generation_id::text,'revision',p.revision,
    'occurredAt',to_char(NEW.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
  IF j.search_projection_id IS NULL OR NEW.schema_version <> 3 OR NEW.event_type <> 'processing.execute'
    OR NEW.correlation_id <> j.correlation_id OR NEW.payload IS DISTINCT FROM expected
    OR octet_length(NEW.payload::text)>4096 THEN
    RAISE EXCEPTION 'Invalid v3 search outbox envelope' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER search_outbox_guard BEFORE INSERT OR UPDATE ON processing_outbox
  FOR EACH ROW EXECUTE FUNCTION search_guard_outbox();

COMMIT;
