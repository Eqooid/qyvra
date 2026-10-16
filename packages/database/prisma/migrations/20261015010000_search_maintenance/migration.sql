-- One schema profile may have multiple isolated physical rebuild generations.
-- Existing fingerprints, names, projections and messages are unchanged.
DROP INDEX search_index_generations_fingerprint_key;
CREATE UNIQUE INDEX search_index_generations_fingerprint_generation_key
  ON search_index_generations(fingerprint,generation);

CREATE TABLE search_maintenance_operations (
  id uuid PRIMARY KEY, kind varchar(16) NOT NULL, initiator varchar(100) NOT NULL,
  user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  generation_id uuid NOT NULL REFERENCES search_index_generations(id) ON DELETE RESTRICT,
  status varchar(16) NOT NULL DEFAULT 'RUNNING', after_document_id uuid,
  examined integer NOT NULL DEFAULT 0, scheduled integer NOT NULL DEFAULT 0,
  skipped integer NOT NULL DEFAULT 0, discrepancies integer NOT NULL DEFAULT 0,
  failures integer NOT NULL DEFAULT 0, last_failure_code varchar(64),
  lease_token uuid, lease_expires_at timestamptz(3),
  created_at timestamptz(3) NOT NULL DEFAULT now(), updated_at timestamptz(3) NOT NULL DEFAULT now(),
  completed_at timestamptz(3), outcome jsonb NOT NULL DEFAULT '{}',
  CONSTRAINT search_maintenance_bounds CHECK (
    kind IN ('BACKFILL','REBUILD','RECONCILE','CLEANUP','CUTOVER')
    AND status IN ('RUNNING','COMPLETED','CANCELLED')
    AND initiator ~ '^[a-zA-Z0-9][a-zA-Z0-9@._:-]{0,99}$'
    AND examined>=0 AND scheduled>=0 AND skipped>=0 AND discrepancies>=0 AND failures>=0
    AND ((lease_token IS NULL)=(lease_expires_at IS NULL))
    AND ((status='RUNNING')=(completed_at IS NULL))
    AND jsonb_typeof(outcome)='object')
);
CREATE INDEX search_maintenance_operations_generation_id_status_idx ON search_maintenance_operations(generation_id,status);
-- Deliberate operational throttle: one live scan/cutover, resumable after a crash.
CREATE UNIQUE INDEX search_maintenance_one_running ON search_maintenance_operations(status) WHERE status='RUNNING';
CREATE FUNCTION search_guard_maintenance() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id,NEW.kind,NEW.initiator,NEW.user_id,NEW.generation_id,NEW.created_at) IS DISTINCT FROM
    (OLD.id,OLD.kind,OLD.initiator,OLD.user_id,OLD.generation_id,OLD.created_at)
    OR (OLD.status<>'RUNNING' AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD))
    OR NEW.examined<OLD.examined OR NEW.scheduled<OLD.scheduled OR NEW.skipped<OLD.skipped
    OR NEW.discrepancies<OLD.discrepancies OR NEW.failures<OLD.failures
    OR (OLD.after_document_id IS NOT NULL AND (NEW.after_document_id IS NULL OR NEW.after_document_id<OLD.after_document_id)) THEN
    RAISE EXCEPTION 'Invalid maintenance checkpoint transition' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER search_maintenance_guard BEFORE UPDATE ON search_maintenance_operations
  FOR EACH ROW EXECUTE FUNCTION search_guard_maintenance();
