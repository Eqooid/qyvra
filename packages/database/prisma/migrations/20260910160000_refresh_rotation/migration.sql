BEGIN;
CREATE TABLE "consumed_refresh_tokens" (
  "token_hash" VARCHAR(64) NOT NULL PRIMARY KEY,
  "session_id" UUID NOT NULL,
  "consumed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "consumed_refresh_tokens_hash_check" CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "consumed_refresh_tokens_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "auth_sessions"("id") ON DELETE CASCADE ON UPDATE RESTRICT
);
CREATE INDEX "consumed_refresh_tokens_session_id_idx" ON "consumed_refresh_tokens"("session_id");
COMMIT;
