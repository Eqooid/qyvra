-- CreateSchema
BEGIN;

CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "identity_provider" AS ENUM ('LOCAL', 'KEYCLOAK', 'OIDC');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "email" VARCHAR(320) NOT NULL,
    "display_name" VARCHAR(100),
    "locale" VARCHAR(35) NOT NULL DEFAULT 'en',
    "timezone" VARCHAR(100) NOT NULL DEFAULT 'UTC',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_identities" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "provider" "identity_provider" NOT NULL,
    "issuer" VARCHAR(2048) NOT NULL,
    "subject" VARCHAR(255) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_identities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "local_credentials" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "password_hash" TEXT NOT NULL,
    "password_changed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "failed_login_attempts" INTEGER NOT NULL DEFAULT 0,
    "last_failed_login_at" TIMESTAMPTZ(3),
    "locked_until" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "local_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "token_hash" VARCHAR(64) NOT NULL,
    "refresh_token_hash" VARCHAR(64),
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "refresh_expires_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),
    "last_used_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "user_identities_user_id_idx" ON "user_identities"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_identities_provider_issuer_subject_key" ON "user_identities"("provider", "issuer", "subject");

-- CreateIndex
CREATE UNIQUE INDEX "local_credentials_user_id_key" ON "local_credentials"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "auth_sessions_token_hash_key" ON "auth_sessions"("token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "auth_sessions_refresh_token_hash_key" ON "auth_sessions"("refresh_token_hash");

-- CreateIndex
CREATE INDEX "auth_sessions_user_id_revoked_at_expires_at_idx" ON "auth_sessions"("user_id", "revoked_at", "expires_at");

-- CreateIndex
CREATE INDEX "auth_sessions_expires_at_idx" ON "auth_sessions"("expires_at");

-- CreateIndex
CREATE INDEX "auth_sessions_refresh_expires_at_idx" ON "auth_sessions"("refresh_expires_at");

-- AddForeignKey
ALTER TABLE "user_identities" ADD CONSTRAINT "user_identities_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "local_credentials" ADD CONSTRAINT "local_credentials_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- These invariants cannot be expressed as Prisma schema attributes.
ALTER TABLE "users"
  ADD CONSTRAINT "users_email_normalized_check" CHECK (
    email = lower(btrim(email)) AND length(email) > 0 AND email !~ '[[:space:]]'
  ),
  ADD CONSTRAINT "users_profile_nonblank_check" CHECK (
    length(btrim(locale)) > 0 AND length(btrim(timezone)) > 0
    AND (display_name IS NULL OR length(btrim(display_name)) > 0)
  );

ALTER TABLE "user_identities"
  ADD CONSTRAINT "user_identities_nonblank_check" CHECK (
    length(btrim(issuer)) > 0 AND length(btrim(subject)) > 0
  ),
  ADD CONSTRAINT "user_identities_local_subject_check" CHECK (
    provider <> 'LOCAL' OR (issuer = 'local' AND subject = user_id::text)
  );

ALTER TABLE "local_credentials"
  ADD CONSTRAINT "local_credentials_argon2id_check" CHECK (
    password_hash ~ '^\$argon2id\$v=19\$m=[1-9][0-9]*,t=[1-9][0-9]*,p=[1-9][0-9]*\$[A-Za-z0-9+/]{8,}\$[A-Za-z0-9+/]{16,}$'
  ),
  ADD CONSTRAINT "local_credentials_failed_attempts_check" CHECK (failed_login_attempts >= 0),
  ADD CONSTRAINT "local_credentials_failed_timestamp_check" CHECK (
    failed_login_attempts = 0 OR last_failed_login_at IS NOT NULL
  );

ALTER TABLE "auth_sessions"
  ADD CONSTRAINT "auth_sessions_token_hash_check" CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "auth_sessions_refresh_hash_check" CHECK (
    refresh_token_hash IS NULL OR refresh_token_hash ~ '^[0-9a-f]{64}$'
  ),
  ADD CONSTRAINT "auth_sessions_refresh_pair_check" CHECK (
    (refresh_token_hash IS NULL) = (refresh_expires_at IS NULL)
  ),
  ADD CONSTRAINT "auth_sessions_expiration_check" CHECK (
    expires_at > created_at AND (refresh_expires_at IS NULL OR refresh_expires_at >= expires_at)
  ),
  ADD CONSTRAINT "auth_sessions_revocation_check" CHECK (revoked_at IS NULL OR revoked_at >= created_at),
  ADD CONSTRAINT "auth_sessions_last_used_check" CHECK (last_used_at IS NULL OR last_used_at >= created_at),
  ADD CONSTRAINT "auth_sessions_distinct_hashes_check" CHECK (refresh_token_hash IS NULL OR refresh_token_hash <> token_hash);

COMMIT;
