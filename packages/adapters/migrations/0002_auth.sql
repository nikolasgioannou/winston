CREATE SCHEMA "winston_auth";
--> statement-breakpoint
CREATE TABLE "winston_auth"."users" (
  "id" uuid PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "email" text NOT NULL UNIQUE,
  "email_verified" boolean NOT NULL,
  "image" text,
  "created_at" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL
);
--> statement-breakpoint
CREATE TABLE "winston_auth"."sessions" (
  "id" uuid PRIMARY KEY NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "winston_auth"."users"("id") ON DELETE CASCADE,
  "token" text NOT NULL UNIQUE,
  "expires_at" timestamptz NOT NULL,
  "ip_address" text,
  "user_agent" text,
  "created_at" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL
);
CREATE INDEX "sessions_user_idx" ON "winston_auth"."sessions"("user_id");
--> statement-breakpoint
CREATE TABLE "winston_auth"."accounts" (
  "id" uuid PRIMARY KEY NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "winston_auth"."users"("id") ON DELETE CASCADE,
  "account_id" text NOT NULL,
  "provider_id" text NOT NULL,
  "access_token" text,
  "refresh_token" text,
  "id_token" text,
  "access_token_expires_at" timestamptz,
  "refresh_token_expires_at" timestamptz,
  "scope" text,
  "password" text,
  "created_at" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL
);
CREATE INDEX "accounts_user_idx" ON "winston_auth"."accounts"("user_id");
CREATE UNIQUE INDEX "accounts_provider_identity_idx" ON "winston_auth"."accounts"("provider_id", "account_id");
--> statement-breakpoint
CREATE TABLE "winston_auth"."verifications" (
  "id" uuid PRIMARY KEY NOT NULL,
  "identifier" text NOT NULL,
  "value" text NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL
);
CREATE INDEX "verifications_identifier_idx" ON "winston_auth"."verifications"("identifier");
