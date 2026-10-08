-- Durable application request receipts; jobs remain in the Phase 3 tables.
CREATE TABLE ai_reprocessing_requests (
  document_version_id uuid NOT NULL,
  document_id uuid NOT NULL,
  user_id uuid NOT NULL,
  key uuid NOT NULL,
  mode varchar(16) NOT NULL CHECK (mode IN ('repair','extraction','chunking','embedding','index')),
  run_id uuid NOT NULL,
  created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (document_version_id, key),
  FOREIGN KEY (run_id, document_version_id, document_id, user_id)
    REFERENCES ai_processing_runs(id, document_version_id, document_id, user_id)
    ON DELETE CASCADE ON UPDATE RESTRICT
);
CREATE INDEX ai_reprocessing_requests_run_id_idx ON ai_reprocessing_requests(run_id);
