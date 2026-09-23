BEGIN;
ALTER TABLE "users" ADD COLUMN "last_login_at" TIMESTAMPTZ(3);
ALTER TABLE "auth_sessions" ADD COLUMN "authentication_method" VARCHAR(32) NOT NULL DEFAULT 'LOCAL_PASSWORD';
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_authentication_method_check" CHECK (authentication_method = 'LOCAL_PASSWORD');
COMMIT;
