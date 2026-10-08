-- Additive Phase 4 persistence only; PostgreSQL DDL is applied atomically.
BEGIN;

-- AlterTable
ALTER TABLE "processing_jobs" ADD COLUMN     "ai_run_id" UUID,
ADD COLUMN     "chunk_set_id" UUID,
ADD COLUMN     "extracted_text_id" UUID,
ADD COLUMN     "predecessor_job_id" UUID,
ADD COLUMN     "vector_index_id" UUID;

-- CreateTable
CREATE TABLE "embedding_profiles" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "fingerprint" VARCHAR(64) NOT NULL,
    "profile_version" INTEGER NOT NULL,
    "provider" VARCHAR(100) NOT NULL,
    "model" VARCHAR(200) NOT NULL,
    "model_revision" VARCHAR(200) NOT NULL,
    "dimensions" INTEGER NOT NULL,
    "distance" VARCHAR(16) NOT NULL DEFAULT 'Cosine',
    "normalization_version" VARCHAR(100) NOT NULL,
    "tokenizer" VARCHAR(100) NOT NULL,
    "tokenizer_version" VARCHAR(100) NOT NULL,
    "document_instruction" VARCHAR(2000) NOT NULL DEFAULT '',
    "query_instruction" VARCHAR(2000) NOT NULL DEFAULT '',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "embedding_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_processing_runs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "document_version_id" UUID NOT NULL,
    "generation" INTEGER NOT NULL,
    "status" VARCHAR(16) NOT NULL DEFAULT 'BUILDING',
    "extractor" VARCHAR(100) NOT NULL,
    "extractor_version" VARCHAR(100) NOT NULL,
    "normalization_version" VARCHAR(100) NOT NULL,
    "chunk_algorithm" VARCHAR(100) NOT NULL,
    "chunk_algorithm_version" VARCHAR(100) NOT NULL,
    "tokenizer" VARCHAR(100) NOT NULL,
    "tokenizer_version" VARCHAR(100) NOT NULL,
    "chunk_size" INTEGER NOT NULL,
    "chunk_overlap" INTEGER NOT NULL,
    "embedding_profile_id" UUID NOT NULL,
    "last_failure_code" VARCHAR(64),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(3),

    CONSTRAINT "ai_processing_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "extracted_texts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "document_version_id" UUID NOT NULL,
    "extraction_fingerprint" VARCHAR(64) NOT NULL,
    "extractor" VARCHAR(100) NOT NULL,
    "extractor_version" VARCHAR(100) NOT NULL,
    "normalization_version" VARCHAR(100) NOT NULL,
    "source_checksum" VARCHAR(64) NOT NULL,
    "content_hash" VARCHAR(64) NOT NULL,
    "text" TEXT NOT NULL,
    "page_spans" JSONB NOT NULL,
    "character_count" INTEGER NOT NULL,
    "page_count" INTEGER NOT NULL,
    "outcome" VARCHAR(16) NOT NULL DEFAULT 'COMPLETED',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "extracted_texts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chunk_sets" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "document_version_id" UUID NOT NULL,
    "extracted_text_id" UUID NOT NULL,
    "extraction_hash" VARCHAR(64) NOT NULL,
    "fingerprint" VARCHAR(64) NOT NULL,
    "algorithm" VARCHAR(100) NOT NULL,
    "algorithm_version" VARCHAR(100) NOT NULL,
    "tokenizer" VARCHAR(100) NOT NULL,
    "tokenizer_version" VARCHAR(100) NOT NULL,
    "chunk_size" INTEGER NOT NULL,
    "chunk_overlap" INTEGER NOT NULL,
    "chunk_count" INTEGER NOT NULL DEFAULT 0,
    "complete" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chunk_sets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_chunks" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "document_version_id" UUID NOT NULL,
    "chunk_set_id" UUID NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "text_hash" VARCHAR(64) NOT NULL,
    "start_offset" INTEGER NOT NULL,
    "end_offset" INTEGER NOT NULL,
    "token_count" INTEGER NOT NULL,
    "page_spans" JSONB NOT NULL,
    "section_label" VARCHAR(300),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_chunks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chunk_embeddings" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "document_version_id" UUID NOT NULL,
    "chunk_id" UUID NOT NULL,
    "embedding_profile_id" UUID NOT NULL,
    "dimensions" INTEGER NOT NULL,
    "input_hash" VARCHAR(64) NOT NULL,
    "vector" DOUBLE PRECISION[],
    "completed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chunk_embeddings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "version_vector_indexes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "document_version_id" UUID NOT NULL,
    "ai_run_id" UUID NOT NULL,
    "chunk_set_id" UUID NOT NULL,
    "embedding_profile_id" UUID NOT NULL,
    "collection_generation" INTEGER NOT NULL,
    "collection_name" VARCHAR(200) NOT NULL,
    "expected_point_count" INTEGER NOT NULL,
    "confirmed_point_count" INTEGER NOT NULL DEFAULT 0,
    "checkpoint_ordinal" INTEGER NOT NULL DEFAULT -1,
    "status" VARCHAR(32) NOT NULL DEFAULT 'BUILDING',
    "last_failure_code" VARCHAR(64),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "indexed_at" TIMESTAMPTZ(3),

    CONSTRAINT "version_vector_indexes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "version_ai_states" (
    "document_version_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "desired_run_id" UUID,
    "last_extraction_job_id" UUID,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "version_ai_states_pkey" PRIMARY KEY ("document_version_id")
);

-- CreateTable
CREATE TABLE "version_ready_indexes" (
    "document_version_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "embedding_profile_id" UUID NOT NULL,
    "vector_index_id" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "version_ready_indexes_pkey" PRIMARY KEY ("document_version_id","embedding_profile_id")
);

-- CreateTable
CREATE TABLE "ai_serving_profile" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "embedding_profile_id" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_serving_profile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "embedding_profiles_fingerprint_key" ON "embedding_profiles"("fingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "embedding_profiles_id_dimensions_key" ON "embedding_profiles"("id", "dimensions");

-- CreateIndex
CREATE INDEX "ai_runs_owner_version_idx" ON "ai_processing_runs"("user_id", "document_id", "document_version_id", "created_at");

-- CreateIndex
CREATE INDEX "ai_processing_runs_status_updated_at_id_idx" ON "ai_processing_runs"("status", "updated_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ai_processing_runs_document_version_id_generation_key" ON "ai_processing_runs"("document_version_id", "generation");

-- CreateIndex
CREATE UNIQUE INDEX "ai_runs_owned_identity_key" ON "ai_processing_runs"("id", "document_version_id", "document_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "ai_runs_profile_key" ON "ai_processing_runs"("id", "embedding_profile_id");

-- CreateIndex
CREATE INDEX "extracted_texts_owner_version_idx" ON "extracted_texts"("user_id", "document_id", "document_version_id");

-- CreateIndex
CREATE UNIQUE INDEX "extracted_texts_version_fingerprint_key" ON "extracted_texts"("document_version_id", "extraction_fingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "extracted_texts_owned_identity_key" ON "extracted_texts"("id", "document_version_id", "document_id", "user_id");

-- CreateIndex
CREATE INDEX "chunk_sets_owner_version_idx" ON "chunk_sets"("user_id", "document_id", "document_version_id");

-- CreateIndex
CREATE UNIQUE INDEX "chunk_sets_document_version_id_fingerprint_key" ON "chunk_sets"("document_version_id", "fingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "chunk_sets_owned_identity_key" ON "chunk_sets"("id", "document_version_id", "document_id", "user_id");

-- CreateIndex
CREATE INDEX "document_chunks_owner_version_idx" ON "document_chunks"("user_id", "document_id", "document_version_id");

-- CreateIndex
CREATE UNIQUE INDEX "document_chunks_chunk_set_id_ordinal_key" ON "document_chunks"("chunk_set_id", "ordinal");

-- CreateIndex
CREATE UNIQUE INDEX "document_chunks_owned_identity_key" ON "document_chunks"("id", "document_version_id", "document_id", "user_id");

-- CreateIndex
CREATE INDEX "chunk_embeddings_owner_profile_idx" ON "chunk_embeddings"("user_id", "document_id", "document_version_id", "embedding_profile_id");

-- CreateIndex
CREATE UNIQUE INDEX "chunk_embeddings_chunk_id_embedding_profile_id_key" ON "chunk_embeddings"("chunk_id", "embedding_profile_id");

-- CreateIndex
CREATE INDEX "vector_indexes_owner_profile_idx" ON "version_vector_indexes"("user_id", "document_id", "document_version_id", "embedding_profile_id", "status");

-- CreateIndex
CREATE INDEX "vector_indexes_reconciliation_idx" ON "version_vector_indexes"("status", "updated_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "version_vector_indexes_ai_run_id_collection_generation_key" ON "version_vector_indexes"("ai_run_id", "collection_generation");

-- CreateIndex
CREATE UNIQUE INDEX "vector_indexes_owned_identity_key" ON "version_vector_indexes"("id", "document_version_id", "document_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "vector_indexes_profile_key" ON "version_vector_indexes"("id", "embedding_profile_id");

-- CreateIndex
CREATE INDEX "version_ai_states_owner_idx" ON "version_ai_states"("user_id", "document_id");

-- CreateIndex
CREATE UNIQUE INDEX "version_ai_states_owned_identity_key" ON "version_ai_states"("document_version_id", "document_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "version_ready_indexes_vector_index_id_key" ON "version_ready_indexes"("vector_index_id");

-- CreateIndex
CREATE INDEX "version_ready_indexes_owner_profile_idx" ON "version_ready_indexes"("user_id", "embedding_profile_id", "document_id");

-- CreateIndex
CREATE UNIQUE INDEX "ai_serving_profile_embedding_profile_id_key" ON "ai_serving_profile"("embedding_profile_id");

-- CreateIndex
CREATE INDEX "processing_jobs_run_type_idx" ON "processing_jobs"("ai_run_id", "job_type");

-- CreateIndex
CREATE INDEX "processing_jobs_predecessor_idx" ON "processing_jobs"("predecessor_job_id");

-- CreateIndex
CREATE UNIQUE INDEX "processing_jobs_owned_identity_key" ON "processing_jobs"("id", "document_version_id", "document_id", "user_id");

-- AddForeignKey
ALTER TABLE "processing_jobs" ADD CONSTRAINT "processing_jobs_ai_run_id_document_version_id_document_id__fkey" FOREIGN KEY ("ai_run_id", "document_version_id", "document_id", "user_id") REFERENCES "ai_processing_runs"("id", "document_version_id", "document_id", "user_id") ON DELETE NO ACTION ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "processing_jobs" ADD CONSTRAINT "processing_jobs_predecessor_job_id_document_version_id_doc_fkey" FOREIGN KEY ("predecessor_job_id", "document_version_id", "document_id", "user_id") REFERENCES "processing_jobs"("id", "document_version_id", "document_id", "user_id") ON DELETE NO ACTION ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "processing_jobs" ADD CONSTRAINT "processing_jobs_extracted_text_id_document_version_id_docu_fkey" FOREIGN KEY ("extracted_text_id", "document_version_id", "document_id", "user_id") REFERENCES "extracted_texts"("id", "document_version_id", "document_id", "user_id") ON DELETE NO ACTION ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "processing_jobs" ADD CONSTRAINT "processing_jobs_chunk_set_id_document_version_id_document__fkey" FOREIGN KEY ("chunk_set_id", "document_version_id", "document_id", "user_id") REFERENCES "chunk_sets"("id", "document_version_id", "document_id", "user_id") ON DELETE NO ACTION ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "processing_jobs" ADD CONSTRAINT "processing_jobs_vector_index_id_document_version_id_docume_fkey" FOREIGN KEY ("vector_index_id", "document_version_id", "document_id", "user_id") REFERENCES "version_vector_indexes"("id", "document_version_id", "document_id", "user_id") ON DELETE NO ACTION ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ai_processing_runs" ADD CONSTRAINT "ai_processing_runs_document_version_id_document_id_user_id_fkey" FOREIGN KEY ("document_version_id", "document_id", "user_id") REFERENCES "document_versions"("id", "document_id", "user_id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ai_processing_runs" ADD CONSTRAINT "ai_processing_runs_embedding_profile_id_fkey" FOREIGN KEY ("embedding_profile_id") REFERENCES "embedding_profiles"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "extracted_texts" ADD CONSTRAINT "extracted_texts_document_version_id_document_id_user_id_fkey" FOREIGN KEY ("document_version_id", "document_id", "user_id") REFERENCES "document_versions"("id", "document_id", "user_id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "chunk_sets" ADD CONSTRAINT "chunk_sets_document_version_id_document_id_user_id_fkey" FOREIGN KEY ("document_version_id", "document_id", "user_id") REFERENCES "document_versions"("id", "document_id", "user_id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "chunk_sets" ADD CONSTRAINT "chunk_sets_extracted_text_id_document_version_id_document__fkey" FOREIGN KEY ("extracted_text_id", "document_version_id", "document_id", "user_id") REFERENCES "extracted_texts"("id", "document_version_id", "document_id", "user_id") ON DELETE NO ACTION ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "document_chunks" ADD CONSTRAINT "document_chunks_document_version_id_document_id_user_id_fkey" FOREIGN KEY ("document_version_id", "document_id", "user_id") REFERENCES "document_versions"("id", "document_id", "user_id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "document_chunks" ADD CONSTRAINT "document_chunks_chunk_set_id_document_version_id_document__fkey" FOREIGN KEY ("chunk_set_id", "document_version_id", "document_id", "user_id") REFERENCES "chunk_sets"("id", "document_version_id", "document_id", "user_id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "chunk_embeddings" ADD CONSTRAINT "chunk_embeddings_document_version_id_document_id_user_id_fkey" FOREIGN KEY ("document_version_id", "document_id", "user_id") REFERENCES "document_versions"("id", "document_id", "user_id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "chunk_embeddings" ADD CONSTRAINT "chunk_embeddings_chunk_id_document_version_id_document_id__fkey" FOREIGN KEY ("chunk_id", "document_version_id", "document_id", "user_id") REFERENCES "document_chunks"("id", "document_version_id", "document_id", "user_id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "chunk_embeddings" ADD CONSTRAINT "chunk_embeddings_embedding_profile_id_dimensions_fkey" FOREIGN KEY ("embedding_profile_id", "dimensions") REFERENCES "embedding_profiles"("id", "dimensions") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "version_vector_indexes" ADD CONSTRAINT "version_vector_indexes_document_version_id_document_id_use_fkey" FOREIGN KEY ("document_version_id", "document_id", "user_id") REFERENCES "document_versions"("id", "document_id", "user_id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "version_vector_indexes" ADD CONSTRAINT "version_vector_indexes_ai_run_id_document_version_id_docum_fkey" FOREIGN KEY ("ai_run_id", "document_version_id", "document_id", "user_id") REFERENCES "ai_processing_runs"("id", "document_version_id", "document_id", "user_id") ON DELETE NO ACTION ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "version_vector_indexes" ADD CONSTRAINT "version_vector_indexes_chunk_set_id_document_version_id_do_fkey" FOREIGN KEY ("chunk_set_id", "document_version_id", "document_id", "user_id") REFERENCES "chunk_sets"("id", "document_version_id", "document_id", "user_id") ON DELETE NO ACTION ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "version_vector_indexes" ADD CONSTRAINT "version_vector_indexes_embedding_profile_id_fkey" FOREIGN KEY ("embedding_profile_id") REFERENCES "embedding_profiles"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "version_ai_states" ADD CONSTRAINT "version_ai_states_document_version_id_document_id_user_id_fkey" FOREIGN KEY ("document_version_id", "document_id", "user_id") REFERENCES "document_versions"("id", "document_id", "user_id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "version_ai_states" ADD CONSTRAINT "version_ai_states_desired_run_id_document_version_id_docum_fkey" FOREIGN KEY ("desired_run_id", "document_version_id", "document_id", "user_id") REFERENCES "ai_processing_runs"("id", "document_version_id", "document_id", "user_id") ON DELETE NO ACTION ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "version_ai_states" ADD CONSTRAINT "version_ai_states_last_extraction_job_id_document_version__fkey" FOREIGN KEY ("last_extraction_job_id", "document_version_id", "document_id", "user_id") REFERENCES "processing_jobs"("id", "document_version_id", "document_id", "user_id") ON DELETE NO ACTION ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "version_ready_indexes" ADD CONSTRAINT "version_ready_indexes_document_version_id_document_id_user_fkey" FOREIGN KEY ("document_version_id", "document_id", "user_id") REFERENCES "document_versions"("id", "document_id", "user_id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "version_ready_indexes" ADD CONSTRAINT "version_ready_indexes_embedding_profile_id_fkey" FOREIGN KEY ("embedding_profile_id") REFERENCES "embedding_profiles"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "version_ready_indexes" ADD CONSTRAINT "version_ready_indexes_vector_index_id_document_version_id__fkey" FOREIGN KEY ("vector_index_id", "document_version_id", "document_id", "user_id") REFERENCES "version_vector_indexes"("id", "document_version_id", "document_id", "user_id") ON DELETE NO ACTION ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ai_serving_profile" ADD CONSTRAINT "ai_serving_profile_embedding_profile_id_fkey" FOREIGN KEY ("embedding_profile_id") REFERENCES "embedding_profiles"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- T02 invariants not representable in Prisma. No jobs, profiles or backfill are seeded.
CREATE UNIQUE INDEX ai_runs_one_building_version_key ON ai_processing_runs(document_version_id)
  WHERE status = 'BUILDING';

ALTER TABLE embedding_profiles ADD CONSTRAINT embedding_profiles_config_check CHECK (
  profile_version > 0 AND dimensions BETWEEN 1 AND 65536 AND distance = 'Cosine'
  AND btrim(provider) <> '' AND btrim(model) <> '' AND btrim(model_revision) <> ''
  AND btrim(normalization_version) <> '' AND btrim(tokenizer) <> '' AND btrim(tokenizer_version) <> ''
  AND fingerprint ~ '^[0-9a-f]{64}$');
ALTER TABLE ai_processing_runs ADD CONSTRAINT ai_runs_config_check CHECK (
  generation > 0 AND chunk_size BETWEEN 1 AND 16384 AND chunk_overlap >= 0 AND chunk_overlap < chunk_size
  AND btrim(extractor) <> '' AND btrim(extractor_version) <> '' AND btrim(normalization_version) <> ''
  AND btrim(chunk_algorithm) <> '' AND btrim(chunk_algorithm_version) <> ''
  AND btrim(tokenizer) <> '' AND btrim(tokenizer_version) <> ''),
  ADD CONSTRAINT ai_runs_state_check CHECK (
  status IN ('BUILDING','READY','FAILED','CANCELLED','SUPERSEDED')
  AND ((status = 'BUILDING') = (completed_at IS NULL))
  AND (completed_at IS NULL OR completed_at >= created_at)
  AND (last_failure_code IS NULL OR last_failure_code ~ '^[A-Z][A-Z0-9_]{0,63}$'));

-- Strict public provenance representation: exact fields, integers and increasing pages.
-- Offsets are Unicode scalar positions in the canonical extracted text, not UTF-16.
CREATE FUNCTION ai_valid_page_spans(spans jsonb, lower_bound integer, upper_bound integer)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE item jsonb; page_no integer; start_pos integer; end_pos integer;
  previous_page integer := 0; previous_end integer := lower_bound;
BEGIN
  IF spans IS NULL OR jsonb_typeof(spans) <> 'array' THEN RETURN false; END IF;
  IF jsonb_array_length(spans) NOT BETWEEN 1 AND 10000 THEN RETURN false; END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(spans) LOOP
    IF jsonb_typeof(item) <> 'object' OR
      (SELECT count(*) FROM jsonb_object_keys(item)) <> 3 OR
      NOT item ?& ARRAY['pageNumber','startOffset','endOffset'] THEN RETURN false; END IF;
    IF jsonb_typeof(item->'pageNumber') <> 'number' OR jsonb_typeof(item->'startOffset') <> 'number'
      OR jsonb_typeof(item->'endOffset') <> 'number'
      OR item->>'pageNumber' !~ '^[0-9]+$' OR item->>'startOffset' !~ '^[0-9]+$'
      OR item->>'endOffset' !~ '^[0-9]+$' THEN RETURN false; END IF;
    page_no := (item->>'pageNumber')::integer;
    start_pos := (item->>'startOffset')::integer; end_pos := (item->>'endOffset')::integer;
    IF page_no <= previous_page OR page_no > 10000 OR start_pos < previous_end
      OR start_pos < lower_bound OR end_pos < start_pos OR end_pos > upper_bound THEN RETURN false; END IF;
    previous_page := page_no; previous_end := end_pos;
  END LOOP;
  RETURN true;
EXCEPTION WHEN numeric_value_out_of_range THEN RETURN false;
END $$;

ALTER TABLE extracted_texts ADD CONSTRAINT extracted_texts_content_check CHECK (
  outcome = 'COMPLETED' AND character_count BETWEEN 1 AND 5000000
  AND character_count = char_length(text) AND octet_length(text) <= 20000000
  AND page_count BETWEEN 1 AND 10000
  AND ai_valid_page_spans(page_spans, 0, character_count)
  AND jsonb_array_length(page_spans) = page_count
  AND (page_spans->0->>'pageNumber')::integer = 1
  AND (page_spans->(page_count-1)->>'pageNumber')::integer = page_count
  AND (page_spans->0->>'startOffset')::integer = 0
  AND (page_spans->(page_count-1)->>'endOffset')::integer = character_count
  AND extraction_fingerprint ~ '^[0-9a-f]{64}$' AND source_checksum ~ '^[0-9a-f]{64}$'
  AND content_hash ~ '^[0-9a-f]{64}$' AND btrim(extractor) <> ''
  AND btrim(extractor_version) <> '' AND btrim(normalization_version) <> '');
ALTER TABLE chunk_sets ADD CONSTRAINT chunk_sets_config_check CHECK (
  fingerprint ~ '^[0-9a-f]{64}$' AND extraction_hash ~ '^[0-9a-f]{64}$'
  AND chunk_size BETWEEN 1 AND 16384 AND chunk_overlap >= 0 AND chunk_overlap < chunk_size
  AND chunk_count BETWEEN 0 AND 100000 AND (NOT complete OR chunk_count > 0)
  AND btrim(algorithm) <> '' AND btrim(algorithm_version) <> ''
  AND btrim(tokenizer) <> '' AND btrim(tokenizer_version) <> '');
ALTER TABLE document_chunks ADD CONSTRAINT document_chunks_content_check CHECK (
  ordinal BETWEEN 0 AND 99999 AND start_offset >= 0 AND end_offset > start_offset
  AND end_offset - start_offset = char_length(text) AND char_length(text) <= 64000
  AND token_count BETWEEN 1 AND 16384 AND text_hash ~ '^[0-9a-f]{64}$'
  AND ai_valid_page_spans(page_spans, start_offset, end_offset));

CREATE FUNCTION ai_valid_vector(values_array double precision[], expected_dimensions integer)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(array_ndims(values_array) = 1 AND array_lower(values_array,1) = 1
    AND cardinality(values_array) = expected_dimensions
    AND NOT EXISTS (SELECT 1 FROM unnest(values_array) v WHERE v IS NULL OR v = 'NaN'::float8
      OR v = 'Infinity'::float8 OR v = '-Infinity'::float8)
    AND EXISTS (SELECT 1 FROM unnest(values_array) v WHERE v <> 0), false)
$$;
ALTER TABLE chunk_embeddings ADD CONSTRAINT chunk_embeddings_vector_check CHECK (
  dimensions BETWEEN 1 AND 65536 AND input_hash ~ '^[0-9a-f]{64}$'
  AND ai_valid_vector(vector, dimensions));
ALTER TABLE version_vector_indexes ADD CONSTRAINT vector_indexes_state_check CHECK (
  status IN ('BUILDING','READY','STALE','REMOVAL_PENDING','REMOVED','FAILED')
  AND collection_generation > 0 AND collection_name ~ '^qyvra_chunks_[a-zA-Z0-9_-]+$'
  AND expected_point_count BETWEEN 1 AND 100000
  AND confirmed_point_count BETWEEN 0 AND expected_point_count
  AND checkpoint_ordinal BETWEEN -1 AND expected_point_count-1
  AND (status <> 'READY' OR (confirmed_point_count = expected_point_count
    AND checkpoint_ordinal = expected_point_count-1 AND indexed_at IS NOT NULL))
  AND (indexed_at IS NULL OR indexed_at >= created_at)
  AND (last_failure_code IS NULL OR last_failure_code ~ '^[A-Z][A-Z0-9_]{0,63}$'));
ALTER TABLE ai_serving_profile ADD CONSTRAINT ai_serving_profile_singleton_check CHECK (id = 1);

-- Successful artifacts and provider configuration cannot silently change identity.
CREATE FUNCTION ai_reject_artifact_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'Immutable AI artifact' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER embedding_profiles_immutable BEFORE UPDATE ON embedding_profiles
  FOR EACH ROW EXECUTE FUNCTION ai_reject_artifact_update();
CREATE TRIGGER extracted_texts_immutable BEFORE UPDATE ON extracted_texts
  FOR EACH ROW EXECUTE FUNCTION ai_reject_artifact_update();
CREATE TRIGGER document_chunks_immutable BEFORE UPDATE ON document_chunks
  FOR EACH ROW EXECUTE FUNCTION ai_reject_artifact_update();
CREATE TRIGGER chunk_embeddings_immutable BEFORE UPDATE ON chunk_embeddings
  FOR EACH ROW EXECUTE FUNCTION ai_reject_artifact_update();

CREATE FUNCTION ai_validate_extraction_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM document_versions WHERE id = NEW.document_version_id
    AND document_id = NEW.document_id AND user_id = NEW.user_id AND checksum_sha256 = NEW.source_checksum) THEN
    RAISE EXCEPTION 'Extraction source mismatch' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER extracted_texts_source BEFORE INSERT ON extracted_texts
  FOR EACH ROW EXECUTE FUNCTION ai_validate_extraction_source();

CREATE FUNCTION ai_validate_chunk_set() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actual_count integer; min_ordinal integer; max_ordinal integer;
BEGIN
  IF TG_OP = 'UPDATE' AND (OLD.complete OR
    (to_jsonb(NEW) - ARRAY['complete','chunk_count']) IS DISTINCT FROM
    (to_jsonb(OLD) - ARRAY['complete','chunk_count'])) AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'Immutable chunk configuration or complete set' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM extracted_texts WHERE id = NEW.extracted_text_id
    AND content_hash = NEW.extraction_hash) THEN
    RAISE EXCEPTION 'Chunk extraction hash mismatch' USING ERRCODE = '23514';
  END IF;
  IF NEW.complete THEN
    SELECT count(*), min(ordinal), max(ordinal) INTO actual_count,min_ordinal,max_ordinal
      FROM document_chunks WHERE chunk_set_id = NEW.id;
    IF actual_count <> NEW.chunk_count OR min_ordinal <> 0 OR max_ordinal <> NEW.chunk_count-1 THEN
      RAISE EXCEPTION 'Incomplete chunk ordering' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER chunk_sets_validate BEFORE INSERT OR UPDATE ON chunk_sets
  FOR EACH ROW EXECUTE FUNCTION ai_validate_chunk_set();

CREATE FUNCTION ai_validate_chunk() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source extracted_texts; chunk_config chunk_sets; spans jsonb;
BEGIN
  SELECT * INTO chunk_config FROM chunk_sets WHERE id = NEW.chunk_set_id FOR UPDATE;
  IF NOT FOUND THEN RETURN NEW; END IF; -- composite FK reports missing parents
  IF chunk_config.complete OR NEW.token_count > chunk_config.chunk_size THEN
    RAISE EXCEPTION 'Chunk set closed or token limit exceeded' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO source FROM extracted_texts WHERE id = chunk_config.extracted_text_id;
  IF NEW.end_offset > source.character_count OR NEW.text IS DISTINCT FROM
    substring(source.text FROM NEW.start_offset+1 FOR NEW.end_offset-NEW.start_offset) THEN
    RAISE EXCEPTION 'Chunk source text mismatch' USING ERRCODE = '23514';
  END IF;
  SELECT jsonb_agg(jsonb_build_object('pageNumber',(p->>'pageNumber')::integer,
    'startOffset',greatest(NEW.start_offset,(p->>'startOffset')::integer),
    'endOffset',least(NEW.end_offset,(p->>'endOffset')::integer)) ORDER BY (p->>'pageNumber')::integer)
    INTO spans FROM jsonb_array_elements(source.page_spans) p
    WHERE (p->>'endOffset')::integer > NEW.start_offset AND (p->>'startOffset')::integer < NEW.end_offset;
  IF spans IS DISTINCT FROM NEW.page_spans THEN
    RAISE EXCEPTION 'Chunk page provenance mismatch' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER document_chunks_validate BEFORE INSERT ON document_chunks
  FOR EACH ROW EXECUTE FUNCTION ai_validate_chunk();

-- Prevent deleting one member of a published set. Deleting the parent/version
-- still cascades all subordinate rows without deleting any authoritative ancestor.
CREATE FUNCTION ai_guard_chunk_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM chunk_sets WHERE id = OLD.chunk_set_id AND complete) THEN
    RAISE EXCEPTION 'Delete the whole chunk set, not a published chunk' USING ERRCODE = '23514';
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER document_chunks_delete BEFORE DELETE ON document_chunks
  FOR EACH ROW EXECUTE FUNCTION ai_guard_chunk_delete();

CREATE FUNCTION ai_validate_run() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM 1 FROM documents WHERE id = NEW.document_id AND user_id = NEW.user_id FOR UPDATE;
    IF NEW.generation <> coalesce((SELECT max(generation) FROM ai_processing_runs
      WHERE document_version_id = NEW.document_version_id),0)+1 THEN
      RAISE EXCEPTION 'Run generation must advance monotonically' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF (to_jsonb(NEW) - ARRAY['status','last_failure_code','updated_at','completed_at']) IS DISTINCT FROM
      (to_jsonb(OLD) - ARRAY['status','last_failure_code','updated_at','completed_at'])
      OR (OLD.status <> 'BUILDING' AND NEW.status NOT IN (OLD.status,'SUPERSEDED')) THEN
      RAISE EXCEPTION 'Immutable run configuration or terminal run' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.status = 'READY' AND NOT EXISTS (SELECT 1 FROM version_vector_indexes
    WHERE ai_run_id = NEW.id AND status = 'READY') THEN
    RAISE EXCEPTION 'Ready run requires ready index' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ai_runs_validate BEFORE INSERT OR UPDATE ON ai_processing_runs
  FOR EACH ROW EXECUTE FUNCTION ai_validate_run();

CREATE FUNCTION ai_validate_index() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source_set chunk_sets; run_config ai_processing_runs; embedded_count integer;
BEGIN
  IF TG_OP = 'UPDATE' AND (to_jsonb(NEW) - ARRAY['status','confirmed_point_count','checkpoint_ordinal',
    'last_failure_code','updated_at','indexed_at']) IS DISTINCT FROM
    (to_jsonb(OLD) - ARRAY['status','confirmed_point_count','checkpoint_ordinal',
    'last_failure_code','updated_at','indexed_at']) THEN
    RAISE EXCEPTION 'Immutable index build identity' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO source_set FROM chunk_sets WHERE id = NEW.chunk_set_id;
  SELECT * INTO run_config FROM ai_processing_runs WHERE id = NEW.ai_run_id;
  IF NOT source_set.complete OR source_set.chunk_count <> NEW.expected_point_count
    OR run_config.embedding_profile_id IS DISTINCT FROM NEW.embedding_profile_id
    OR source_set.algorithm IS DISTINCT FROM run_config.chunk_algorithm
    OR source_set.algorithm_version IS DISTINCT FROM run_config.chunk_algorithm_version
    OR source_set.tokenizer IS DISTINCT FROM run_config.tokenizer
    OR source_set.tokenizer_version IS DISTINCT FROM run_config.tokenizer_version
    OR source_set.chunk_size IS DISTINCT FROM run_config.chunk_size
    OR source_set.chunk_overlap IS DISTINCT FROM run_config.chunk_overlap
    OR NOT EXISTS (SELECT 1 FROM extracted_texts e WHERE e.id=source_set.extracted_text_id
      AND e.extractor=run_config.extractor AND e.extractor_version=run_config.extractor_version
      AND e.normalization_version=run_config.normalization_version) THEN
    RAISE EXCEPTION 'Index requires complete compatible inputs' USING ERRCODE = '23514';
  END IF;
  SELECT count(*) INTO embedded_count FROM chunk_embeddings e JOIN document_chunks c ON c.id=e.chunk_id
    WHERE c.chunk_set_id = NEW.chunk_set_id AND e.embedding_profile_id = NEW.embedding_profile_id;
  IF NEW.status IN ('BUILDING','READY') AND embedded_count <> NEW.expected_point_count THEN
    RAISE EXCEPTION 'Index requires all embedding checkpoints' USING ERRCODE = '23514';
  END IF;
  IF NEW.status <> 'READY' AND EXISTS (SELECT 1 FROM version_ready_indexes WHERE vector_index_id = NEW.id) THEN
    RAISE EXCEPTION 'Revoke ready mapping before retiring index' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER vector_indexes_validate BEFORE INSERT OR UPDATE ON version_vector_indexes
  FOR EACH ROW EXECUTE FUNCTION ai_validate_index();

CREATE FUNCTION ai_validate_ready_mapping() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM documents WHERE id = NEW.document_id AND user_id = NEW.user_id FOR UPDATE;
  IF NOT EXISTS (SELECT 1 FROM version_vector_indexes i JOIN version_ai_states s
    ON s.document_version_id=i.document_version_id JOIN documents d ON d.id=i.document_id
    JOIN ai_processing_runs r ON r.id=i.ai_run_id
    WHERE i.id=NEW.vector_index_id AND i.embedding_profile_id=NEW.embedding_profile_id AND i.status='READY'
      AND s.desired_run_id=i.ai_run_id AND r.status IN ('BUILDING','READY')
      AND d.deleted_at IS NULL AND NOT d.is_archived
      AND d.status NOT IN ('ARCHIVED','DELETING')
      AND i.document_version_id=(SELECT id FROM document_versions WHERE document_id=d.id
        ORDER BY version_number DESC LIMIT 1)) THEN
    RAISE EXCEPTION 'Ready mapping requires eligible desired current-version build' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER version_ready_indexes_validate BEFORE INSERT OR UPDATE ON version_ready_indexes
  FOR EACH ROW EXECUTE FUNCTION ai_validate_ready_mapping();

CREATE FUNCTION ai_validate_version_state() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.last_extraction_job_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM processing_jobs
    WHERE id=NEW.last_extraction_job_id AND job_type='EXTRACT_TEXT') THEN
    RAISE EXCEPTION 'Extraction pointer requires extraction job' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER version_ai_states_validate BEFORE INSERT OR UPDATE ON version_ai_states
  FOR EACH ROW EXECUTE FUNCTION ai_validate_version_state();

ALTER TABLE processing_jobs ADD CONSTRAINT processing_jobs_ai_inputs_check CHECK (
  (job_type NOT IN ('EXTRACT_TEXT','GENERATE_CHUNKS','GENERATE_EMBEDDINGS','INDEX_VECTORS')
    OR (ai_run_id IS NOT NULL AND predecessor_job_id IS NOT NULL))
  AND (job_type <> 'GENERATE_CHUNKS' OR extracted_text_id IS NOT NULL)
  AND (job_type NOT IN ('GENERATE_EMBEDDINGS','INDEX_VECTORS') OR chunk_set_id IS NOT NULL)
  AND (job_type NOT IN ('INDEX_VECTORS','REMOVE_VECTOR_INDEX') OR vector_index_id IS NOT NULL)
  AND (predecessor_job_id IS NULL OR predecessor_job_id <> id));

CREATE FUNCTION ai_validate_stage_job() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE prerequisite processing_jobs; config ai_processing_runs; artifact extracted_texts;
  source_set chunk_sets; index_build version_vector_indexes; expected_type text; embedded_count integer;
BEGIN
  IF NEW.job_type NOT IN ('EXTRACT_TEXT','GENERATE_CHUNKS','GENERATE_EMBEDDINGS','INDEX_VECTORS','REMOVE_VECTOR_INDEX') THEN
    RETURN NEW;
  END IF;
  IF TG_OP='UPDATE' THEN
    IF NEW.ai_run_id IS DISTINCT FROM OLD.ai_run_id OR NEW.predecessor_job_id IS DISTINCT FROM OLD.predecessor_job_id
      OR NEW.job_type IS DISTINCT FROM OLD.job_type
      OR (OLD.extracted_text_id IS NOT NULL AND NEW.extracted_text_id IS DISTINCT FROM OLD.extracted_text_id)
      OR (OLD.chunk_set_id IS NOT NULL AND NEW.chunk_set_id IS DISTINCT FROM OLD.chunk_set_id)
      OR (OLD.vector_index_id IS NOT NULL AND NEW.vector_index_id IS DISTINCT FROM OLD.vector_index_id) THEN
      RAISE EXCEPTION 'Immutable stage inputs' USING ERRCODE='23514';
    END IF;
  END IF;
  IF NEW.job_type='REMOVE_VECTOR_INDEX' THEN
    IF NEW.status='COMPLETED' AND NOT EXISTS (SELECT 1 FROM version_vector_indexes
      WHERE id=NEW.vector_index_id AND status='REMOVED') THEN
      RAISE EXCEPTION 'Cleanup completion requires removed manifest' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  expected_type := CASE NEW.job_type WHEN 'EXTRACT_TEXT' THEN 'VERIFY_STORED_FILE'
    WHEN 'GENERATE_CHUNKS' THEN 'EXTRACT_TEXT' WHEN 'GENERATE_EMBEDDINGS' THEN 'GENERATE_CHUNKS'
    WHEN 'INDEX_VECTORS' THEN 'GENERATE_EMBEDDINGS' END;
  SELECT * INTO prerequisite FROM processing_jobs WHERE id=NEW.predecessor_job_id;
  IF NOT FOUND THEN RETURN NEW; END IF;
  IF prerequisite.job_type IS DISTINCT FROM expected_type OR prerequisite.status <> 'COMPLETED'
    OR (expected_type <> 'VERIFY_STORED_FILE' AND prerequisite.ai_run_id IS DISTINCT FROM NEW.ai_run_id) THEN
    RAISE EXCEPTION 'Stage requires completed compatible predecessor' USING ERRCODE='23514';
  END IF;
  SELECT * INTO config FROM ai_processing_runs WHERE id=NEW.ai_run_id;
  IF NEW.extracted_text_id IS NOT NULL THEN
    SELECT * INTO artifact FROM extracted_texts WHERE id=NEW.extracted_text_id;
    IF artifact.extractor IS DISTINCT FROM config.extractor OR artifact.extractor_version IS DISTINCT FROM config.extractor_version
      OR artifact.normalization_version IS DISTINCT FROM config.normalization_version THEN
      RAISE EXCEPTION 'Extraction configuration mismatch' USING ERRCODE='23514';
    END IF;
  END IF;
  IF NEW.chunk_set_id IS NOT NULL THEN
    SELECT * INTO source_set FROM chunk_sets WHERE id=NEW.chunk_set_id;
    IF NOT source_set.complete OR source_set.algorithm IS DISTINCT FROM config.chunk_algorithm
      OR source_set.algorithm_version IS DISTINCT FROM config.chunk_algorithm_version
      OR source_set.tokenizer IS DISTINCT FROM config.tokenizer OR source_set.tokenizer_version IS DISTINCT FROM config.tokenizer_version
      OR source_set.chunk_size IS DISTINCT FROM config.chunk_size OR source_set.chunk_overlap IS DISTINCT FROM config.chunk_overlap
      OR (NEW.job_type='GENERATE_CHUNKS' AND source_set.extracted_text_id IS DISTINCT FROM NEW.extracted_text_id) THEN
      RAISE EXCEPTION 'Chunk configuration mismatch' USING ERRCODE='23514';
    END IF;
    IF NEW.job_type IN ('GENERATE_EMBEDDINGS','INDEX_VECTORS') AND prerequisite.chunk_set_id IS DISTINCT FROM NEW.chunk_set_id THEN
      RAISE EXCEPTION 'Chunk predecessor mismatch' USING ERRCODE='23514';
    END IF;
  END IF;
  IF NEW.job_type='GENERATE_CHUNKS' AND prerequisite.extracted_text_id IS DISTINCT FROM NEW.extracted_text_id THEN
    RAISE EXCEPTION 'Extraction predecessor mismatch' USING ERRCODE='23514';
  END IF;
  IF NEW.vector_index_id IS NOT NULL THEN
    SELECT * INTO index_build FROM version_vector_indexes WHERE id=NEW.vector_index_id;
    IF index_build.ai_run_id IS DISTINCT FROM NEW.ai_run_id OR index_build.chunk_set_id IS DISTINCT FROM NEW.chunk_set_id THEN
      RAISE EXCEPTION 'Index input mismatch' USING ERRCODE='23514';
    END IF;
  END IF;
  IF NEW.status='COMPLETED' THEN
    IF (NEW.job_type='EXTRACT_TEXT' AND NEW.extracted_text_id IS NULL)
      OR (NEW.job_type='GENERATE_CHUNKS' AND NEW.chunk_set_id IS NULL)
      OR (NEW.job_type='INDEX_VECTORS' AND index_build.status IS DISTINCT FROM 'READY') THEN
      RAISE EXCEPTION 'Stage output absent' USING ERRCODE='23514';
    END IF;
    IF NEW.job_type='GENERATE_EMBEDDINGS' THEN
      SELECT count(*) INTO embedded_count FROM chunk_embeddings e JOIN document_chunks c ON c.id=e.chunk_id
        WHERE c.chunk_set_id=NEW.chunk_set_id AND e.embedding_profile_id=config.embedding_profile_id;
      IF embedded_count <> source_set.chunk_count THEN
        RAISE EXCEPTION 'Embedding stage output incomplete' USING ERRCODE='23514';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER processing_jobs_ai_validate BEFORE INSERT OR UPDATE ON processing_jobs
  FOR EACH ROW EXECUTE FUNCTION ai_validate_stage_job();

-- Enforce semantic profile identity even for writers bypassing the TS helper.
CREATE FUNCTION ai_validate_profile_fingerprint() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE canonical text;
BEGIN
  canonical := '[' || array_to_string(ARRAY[
    to_json('qyvra.embedding-profile.v1'::text)::text, to_json(NEW.profile_version)::text,
    to_json(NEW.provider)::text, to_json(NEW.model)::text, to_json(NEW.model_revision)::text,
    to_json(NEW.dimensions)::text, to_json(NEW.distance)::text,
    to_json(NEW.normalization_version)::text, to_json(NEW.tokenizer)::text,
    to_json(NEW.tokenizer_version)::text, to_json(NEW.document_instruction)::text,
    to_json(NEW.query_instruction)::text], ',') || ']';
  IF NEW.fingerprint IS DISTINCT FROM encode(sha256(convert_to(canonical,'UTF8')),'hex') THEN
    RAISE EXCEPTION 'Embedding profile fingerprint mismatch' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER embedding_profiles_fingerprint BEFORE INSERT ON embedding_profiles
  FOR EACH ROW EXECUTE FUNCTION ai_validate_profile_fingerprint();

CREATE FUNCTION ai_validate_embedding_parent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM document_chunks c JOIN chunk_sets s ON s.id=c.chunk_set_id
    WHERE c.id=NEW.chunk_id AND s.complete) THEN
    RAISE EXCEPTION 'Embedding requires complete chunk set' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER chunk_embeddings_parent BEFORE INSERT ON chunk_embeddings
  FOR EACH ROW EXECUTE FUNCTION ai_validate_embedding_parent();

CREATE FUNCTION ai_guard_embedding_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM document_versions WHERE id=OLD.document_version_id) AND EXISTS (
    SELECT 1 FROM version_vector_indexes i JOIN document_chunks c ON c.chunk_set_id=i.chunk_set_id
      WHERE c.id=OLD.chunk_id AND i.embedding_profile_id=OLD.embedding_profile_id
      AND i.status IN ('BUILDING','READY')) THEN
    RAISE EXCEPTION 'Retire index before deleting checkpoints' USING ERRCODE='23514';
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER chunk_embeddings_delete BEFORE DELETE ON chunk_embeddings
  FOR EACH ROW EXECUTE FUNCTION ai_guard_embedding_delete();

CREATE FUNCTION ai_guard_ready_index_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM document_versions WHERE id=OLD.document_version_id)
    AND EXISTS (SELECT 1 FROM ai_processing_runs WHERE id=OLD.ai_run_id AND status='READY') THEN
    RAISE EXCEPTION 'Supersede ready run before deleting index' USING ERRCODE='23514';
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER vector_indexes_delete BEFORE DELETE ON version_vector_indexes
  FOR EACH ROW EXECUTE FUNCTION ai_guard_ready_index_delete();

COMMIT;

