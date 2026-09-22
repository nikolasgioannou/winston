CREATE TABLE winston.conversations (
  owner_id uuid PRIMARY KEY REFERENCES winston.owners(id),
  id uuid NOT NULL UNIQUE,
  revision integer NOT NULL DEFAULT 0,
  response_revision integer NOT NULL DEFAULT 0,
  CHECK (response_revision <= revision)
);
--> statement-breakpoint
CREATE TABLE winston.conversation_messages (
  owner_id uuid NOT NULL REFERENCES winston.conversations(owner_id),
  id uuid NOT NULL,
  bot_id bigint NOT NULL,
  chat_id bigint NOT NULL,
  provider_message_id bigint NOT NULL,
  provider_sent_at timestamptz NOT NULL,
  source_update_id bigint NOT NULL,
  media_group_id text,
  envelope jsonb NOT NULL,
  PRIMARY KEY (owner_id, id),
  UNIQUE (owner_id, bot_id, chat_id, provider_message_id)
);
--> statement-breakpoint
CREATE INDEX conversation_messages_window ON winston.conversation_messages
  (owner_id, provider_sent_at DESC, bot_id DESC, chat_id DESC, provider_message_id DESC);
--> statement-breakpoint
CREATE INDEX telegram_updates_message ON winston.telegram_updates
  (owner_id, bot_id, ((COALESCE(payload->'message', payload->'edited_message')->>'message_id')));
