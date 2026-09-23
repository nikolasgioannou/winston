CREATE TABLE winston.telegram_intake (
  owner_id uuid NOT NULL,
  id uuid NOT NULL,
  message_id uuid NOT NULL,
  bot_id bigint NOT NULL,
  file_id text NOT NULL,
  filename text NOT NULL,
  media_type text NOT NULL,
  expected_size bigint,
  voice boolean NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'downloading', 'stored', 'staged', 'failed', 'canceled')),
  artifact_id uuid,
  attempts integer NOT NULL DEFAULT 0,
  lease_token uuid,
  leased_until timestamptz,
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (owner_id, id),
  FOREIGN KEY (owner_id, message_id) REFERENCES winston.conversation_messages(owner_id, id),
  FOREIGN KEY (owner_id, artifact_id) REFERENCES winston.artifacts(owner_id, id)
);
--> statement-breakpoint
CREATE INDEX telegram_intake_pending ON winston.telegram_intake (owner_id, bot_id, created_at, id)
  WHERE state IN ('pending', 'downloading', 'stored');
