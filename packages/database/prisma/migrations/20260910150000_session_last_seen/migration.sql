BEGIN;
ALTER TABLE "auth_sessions" RENAME COLUMN "last_used_at" TO "last_seen_at";
ALTER TABLE "auth_sessions" RENAME CONSTRAINT "auth_sessions_last_used_check" TO "auth_sessions_last_seen_check";
COMMIT;
