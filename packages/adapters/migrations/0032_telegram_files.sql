CREATE TABLE winston.telegram_files (
  owner_id uuid NOT NULL,
  id uuid NOT NULL,
  request_key text NOT NULL,
  task_id uuid NOT NULL,
  intent_revision integer NOT NULL,
  artifact_id uuid NOT NULL,
  bot_id bigint NOT NULL,
  chat_id bigint NOT NULL,
  permission_snapshot jsonb NOT NULL,
  sequence bigint GENERATED ALWAYS AS IDENTITY,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'preparing', 'sending', 'uncertain', 'delivered', 'failed', 'canceled')),
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_token uuid,
  leased_until timestamptz,
  message_id bigint,
  PRIMARY KEY (owner_id, id),
  UNIQUE (owner_id, request_key),
  FOREIGN KEY (owner_id, task_id) REFERENCES winston.tasks(owner_id, id),
  FOREIGN KEY (owner_id, artifact_id) REFERENCES winston.artifacts(owner_id, id)
);
--> statement-breakpoint
CREATE INDEX telegram_files_pending ON winston.telegram_files (owner_id, bot_id, sequence)
  WHERE state IN ('pending', 'preparing', 'sending');
