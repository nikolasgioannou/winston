CREATE TABLE winston.tasks (
  owner_id uuid NOT NULL REFERENCES winston.owners(id),
  id uuid NOT NULL,
  request_key text NOT NULL,
  request_hash text NOT NULL,
  document jsonb NOT NULL,
  leased_until timestamptz,
  PRIMARY KEY (owner_id, id),
  UNIQUE (owner_id, request_key)
);
--> statement-breakpoint
CREATE INDEX tasks_active ON winston.tasks (owner_id, (document->>'state'), id);
--> statement-breakpoint
CREATE TABLE winston.task_revisions (
  owner_id uuid NOT NULL,
  task_id uuid NOT NULL,
  revision integer NOT NULL,
  document jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (owner_id, task_id, revision),
  FOREIGN KEY (owner_id, task_id) REFERENCES winston.tasks(owner_id, id)
);
