CREATE TABLE winston.telegram_approvals (
  owner_id uuid NOT NULL,
  action_id uuid NOT NULL,
  revision integer NOT NULL,
  action_hash text NOT NULL,
  bot_id bigint NOT NULL,
  user_id bigint NOT NULL,
  chat_id bigint NOT NULL,
  outbound_id uuid NOT NULL,
  approve_hash text NOT NULL UNIQUE,
  reject_hash text NOT NULL UNIQUE,
  result text CHECK (result IN ('approved', 'denied', 'invalidated')),
  PRIMARY KEY (owner_id, action_id, revision, bot_id),
  FOREIGN KEY (owner_id, action_id) REFERENCES winston.actions(owner_id, id),
  FOREIGN KEY (owner_id, outbound_id) REFERENCES winston.telegram_outbound(owner_id, id)
);
