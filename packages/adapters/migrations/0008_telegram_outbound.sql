CREATE TABLE winston.telegram_outbound (
  owner_id uuid NOT NULL REFERENCES winston.owners(id),
  id uuid NOT NULL,
  request_key text NOT NULL,
  bot_id bigint NOT NULL,
  chat_id bigint NOT NULL,
  sequence bigint GENERATED ALWAYS AS IDENTITY,
  parts jsonb NOT NULL,
  next_part integer NOT NULL DEFAULT 0,
  sent_ids jsonb NOT NULL DEFAULT '[]',
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'sending', 'uncertain', 'delivered', 'failed', 'canceled')),
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_token uuid,
  leased_until timestamptz,
  PRIMARY KEY (owner_id, id),
  UNIQUE (owner_id, request_key)
);
--> statement-breakpoint
CREATE INDEX telegram_outbound_pending ON winston.telegram_outbound (owner_id, bot_id, sequence)
  WHERE state IN ('pending', 'sending', 'uncertain');
