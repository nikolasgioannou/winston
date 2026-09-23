CREATE TABLE winston.task_steps (
  owner_id uuid NOT NULL,
  task_id uuid NOT NULL,
  intent_revision integer NOT NULL CHECK (intent_revision >= 0),
  sequence integer NOT NULL CHECK (sequence BETWEEN 1 AND 10000),
  id uuid NOT NULL,
  request_key text NOT NULL,
  document jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (owner_id, task_id, intent_revision, sequence),
  UNIQUE (owner_id, task_id, intent_revision, request_key),
  UNIQUE (owner_id, id),
  FOREIGN KEY (owner_id, task_id) REFERENCES winston.tasks(owner_id, id)
);
--> statement-breakpoint
CREATE UNIQUE INDEX task_steps_tool_call ON winston.task_steps
  (owner_id, task_id, intent_revision, (document->'request'->'payload'->>'modelStepId'),
    (document->'request'->'payload'->>'callId'))
  WHERE document->'request'->'payload'->>'kind' = 'tool';
