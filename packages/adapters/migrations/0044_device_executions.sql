CREATE TABLE winston.device_executions (
  owner_id uuid NOT NULL,
  device_id uuid NOT NULL,
  execution_id uuid NOT NULL,
  action_id uuid NOT NULL,
  session_id uuid NOT NULL,
  generation bigint NOT NULL CHECK (generation BETWEEN 1 AND 9007199254740991),
  resource text NOT NULL CHECK (resource IN ('desktop', 'file')),
  slot integer NOT NULL CHECK (slot BETWEEN 0 AND 1 AND (resource = 'file' OR slot = 0)),
  state text NOT NULL CHECK (state IN ('dispatching', 'accepted', 'running', 'unknown', 'succeeded', 'failed', 'canceled')),
  deadline timestamptz NOT NULL,
  document jsonb NOT NULL,
  PRIMARY KEY (owner_id, execution_id),
  UNIQUE (owner_id, action_id),
  FOREIGN KEY (owner_id, device_id) REFERENCES winston.devices(owner_id, id),
  FOREIGN KEY (owner_id, action_id) REFERENCES winston.actions(owner_id, id)
);
--> statement-breakpoint
CREATE UNIQUE INDEX device_execution_resources ON winston.device_executions (owner_id, device_id, resource, slot)
  WHERE state IN ('dispatching', 'accepted', 'running', 'unknown');
--> statement-breakpoint
CREATE INDEX device_executions_pending ON winston.device_executions (owner_id, deadline)
  WHERE state IN ('dispatching', 'accepted', 'running');
