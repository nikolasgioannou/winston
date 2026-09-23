ALTER TABLE winston.tasks ADD COLUMN intent_revision integer NOT NULL DEFAULT 0 CHECK (intent_revision >= 0);
--> statement-breakpoint
CREATE TABLE winston.actions (
  owner_id uuid NOT NULL,
  id uuid NOT NULL,
  task_id uuid NOT NULL,
  request_key text NOT NULL,
  request_hash text NOT NULL,
  document jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  dispatch_token_hash text,
  PRIMARY KEY (owner_id, id),
  UNIQUE (owner_id, request_key),
  FOREIGN KEY (owner_id, task_id) REFERENCES winston.tasks(owner_id, id)
);
--> statement-breakpoint
CREATE INDEX actions_pending ON winston.actions (owner_id, (document->>'state'), expires_at);
