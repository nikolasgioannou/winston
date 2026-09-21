ALTER TABLE "winston"."owners"
  ADD COLUMN "timezone" text NOT NULL DEFAULT 'UTC',
  ADD COLUMN "timezone_revision" integer NOT NULL DEFAULT 0 CHECK (timezone_revision >= 0),
  ADD COLUMN "timezone_observed_at" timestamptz,
  ADD COLUMN "timezone_source" text NOT NULL DEFAULT 'default' CHECK (timezone_source IN ('default', 'browser'));
