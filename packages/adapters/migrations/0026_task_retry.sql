ALTER TABLE winston.tasks
  ADD COLUMN retry_at timestamptz,
  ADD COLUMN retry_key text,
  ADD COLUMN retry_attempt integer NOT NULL DEFAULT 0 CHECK (retry_attempt BETWEEN 0 AND 8);
--> statement-breakpoint
CREATE INDEX tasks_retry_due ON winston.tasks (owner_id, retry_at, id) WHERE retry_at IS NOT NULL;
