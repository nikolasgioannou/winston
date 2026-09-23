CREATE TABLE winston.schedules (
  owner_id uuid NOT NULL REFERENCES winston.owners(id),
  id uuid NOT NULL,
  request_key text NOT NULL,
  request_hash text NOT NULL,
  document jsonb NOT NULL,
  next_run_at timestamptz,
  PRIMARY KEY (owner_id, id),
  UNIQUE (owner_id, request_key)
);
--> statement-breakpoint
CREATE INDEX schedules_due ON winston.schedules (next_run_at, owner_id, id)
  WHERE document->>'state' = 'active';
--> statement-breakpoint
CREATE TABLE winston.schedule_occurrences (
  owner_id uuid NOT NULL,
  schedule_id uuid NOT NULL,
  revision integer NOT NULL,
  due_at timestamptz NOT NULL,
  task_id uuid NOT NULL,
  PRIMARY KEY (owner_id, schedule_id, revision, due_at),
  UNIQUE (owner_id, task_id),
  FOREIGN KEY (owner_id, schedule_id) REFERENCES winston.schedules(owner_id, id),
  FOREIGN KEY (owner_id, task_id) REFERENCES winston.tasks(owner_id, id)
);
