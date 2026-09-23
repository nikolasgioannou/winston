CREATE TABLE winston.handoffs (
  owner_id uuid NOT NULL,
  id uuid NOT NULL,
  task_id uuid NOT NULL,
  request_key text NOT NULL,
  request_hash text NOT NULL,
  document jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (owner_id, id),
  UNIQUE (owner_id, request_key),
  FOREIGN KEY (owner_id, task_id) REFERENCES winston.tasks(owner_id, id)
);
