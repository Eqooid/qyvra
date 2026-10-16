-- T03 canonical metadata fencing. No enrollment, generation seed or remote I/O.
BEGIN;

CREATE FUNCTION search_metadata_hash(version_id uuid) RETURNS text LANGUAGE sql VOLATILE AS $$
  SELECT encode(sha256(convert_to(jsonb_build_array(
    'qyvra.search-metadata.v1', d.id::text, d.user_id::text, v.id::text,
    d.title, d.description, d.document_type, d.status, d.issuer, d.reference_number,
    d.category_id::text, to_char(d.document_date,'YYYY-MM-DD'),
    to_char(d.expiration_date,'YYYY-MM-DD'),
    to_char(d.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    to_char(d.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    v.version_number, v.original_filename, v.mime_type, v.file_size,
    to_char(v.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    COALESCE((SELECT jsonb_agg(t.tag_id::text ORDER BY t.tag_id)
      FROM document_tags t WHERE t.document_id=d.id AND t.user_id=d.user_id),'[]'::jsonb)
  )::text,'UTF8')),'hex')
  FROM document_versions v JOIN documents d ON d.id=v.document_id AND d.user_id=v.user_id
  WHERE v.id=version_id
$$;

CREATE FUNCTION search_guard_canonical_projection() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM documents WHERE id=NEW.document_id AND user_id=NEW.user_id FOR UPDATE;
  IF NEW.status='READY' AND NEW.metadata_hash IS DISTINCT FROM search_metadata_hash(NEW.document_version_id) THEN
    RAISE EXCEPTION 'Stale canonical search metadata' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER search_canonical_projection BEFORE INSERT OR UPDATE ON version_search_projections
  FOR EACH ROW EXECUTE FUNCTION search_guard_canonical_projection();

CREATE FUNCTION search_guard_canonical_pointer() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM documents WHERE id=NEW.document_id AND user_id=NEW.user_id FOR UPDATE;
  IF NEW.ready_projection_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM version_search_projections p WHERE p.id=NEW.ready_projection_id
      AND p.metadata_hash=search_metadata_hash(NEW.desired_version_id)) THEN
    RAISE EXCEPTION 'Stale canonical search publication' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER search_canonical_pointer BEFORE INSERT OR UPDATE ON document_search_states
  FOR EACH ROW EXECUTE FUNCTION search_guard_canonical_pointer();

COMMIT;
