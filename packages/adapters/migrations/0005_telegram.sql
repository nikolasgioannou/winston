CREATE TABLE winston.telegram_challenges (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES winston.owners(id),
  bot_id bigint NOT NULL,
  session_hash text NOT NULL,
  secret_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  candidate_id bigint,
  candidate_name text,
  confirmed_at timestamptz
);
--> statement-breakpoint
CREATE INDEX telegram_challenges_owner ON winston.telegram_challenges(owner_id, bot_id);
--> statement-breakpoint
CREATE TABLE winston.telegram_bindings (
  owner_id uuid NOT NULL REFERENCES winston.owners(id),
  bot_id bigint NOT NULL,
  user_id bigint NOT NULL,
  chat_id bigint NOT NULL,
  PRIMARY KEY (owner_id, bot_id),
  UNIQUE (bot_id, user_id),
  UNIQUE (bot_id, chat_id)
);
--> statement-breakpoint
CREATE TABLE winston.telegram_updates (
  bot_id bigint NOT NULL,
  update_id bigint NOT NULL,
  owner_id uuid NOT NULL REFERENCES winston.owners(id),
  received_at timestamptz NOT NULL,
  timezone_snapshot jsonb NOT NULL,
  payload jsonb NOT NULL,
  PRIMARY KEY (bot_id, update_id)
);
