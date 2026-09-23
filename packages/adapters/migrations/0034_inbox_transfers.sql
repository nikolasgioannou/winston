CREATE TABLE winston.inbox_transfers (
  owner_id uuid NOT NULL,
  intake_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  workspace_revision integer NOT NULL,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (owner_id, intake_id),
  FOREIGN KEY (owner_id, intake_id) REFERENCES winston.telegram_intake(owner_id, id),
  FOREIGN KEY (owner_id, workspace_id) REFERENCES winston.workspaces(owner_id, id)
);
