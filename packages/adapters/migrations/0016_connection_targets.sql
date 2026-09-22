CREATE TABLE winston.connection_target_preferences (
  owner_id uuid PRIMARY KEY REFERENCES winston.owners(id) ON DELETE CASCADE,
  document jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE winston.task_connection_targets (
  owner_id uuid NOT NULL REFERENCES winston.owners(id) ON DELETE CASCADE,
  task_id uuid NOT NULL,
  task_revision integer NOT NULL,
  operation text NOT NULL,
  document jsonb NOT NULL,
  PRIMARY KEY (owner_id, task_id, task_revision, operation),
  FOREIGN KEY (owner_id, task_id) REFERENCES winston.tasks(owner_id, id) ON DELETE CASCADE
);
