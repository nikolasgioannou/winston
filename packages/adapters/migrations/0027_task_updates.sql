CREATE TABLE winston.task_updates (
  owner_id uuid NOT NULL,
  event_id text NOT NULL,
  task_id uuid NOT NULL,
  task_revision integer NOT NULL CHECK (task_revision >= 0),
  document jsonb NOT NULL,
  response_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (owner_id, event_id),
  UNIQUE (owner_id, task_id, task_revision),
  FOREIGN KEY (owner_id, event_id) REFERENCES winston.events(owner_id, id),
  FOREIGN KEY (owner_id, task_id, task_revision) REFERENCES winston.task_revisions(owner_id, task_id, revision),
  FOREIGN KEY (owner_id, response_id) REFERENCES winston.telegram_outbound(owner_id, id)
);
--> statement-breakpoint
CREATE INDEX task_updates_presentation ON winston.task_updates (owner_id, created_at, event_id);
