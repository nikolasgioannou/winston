CREATE TABLE winston.google_connections (
  owner_id uuid NOT NULL REFERENCES winston.owners(id),
  id uuid NOT NULL,
  subject text NOT NULL,
  service text NOT NULL CHECK (service IN ('gmail', 'calendar')),
  document jsonb NOT NULL,
  PRIMARY KEY (owner_id, id),
  UNIQUE (owner_id, subject, service),
  FOREIGN KEY (owner_id, id) REFERENCES winston.credentials(owner_id, id) DEFERRABLE INITIALLY DEFERRED
);
--> statement-breakpoint
CREATE TABLE winston.google_challenges (
  owner_id uuid NOT NULL REFERENCES winston.owners(id),
  id uuid NOT NULL,
  state_hash text NOT NULL UNIQUE,
  session_hash text NOT NULL,
  intent jsonb NOT NULL,
  expected_subject text,
  expected_revision integer,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  completed_at timestamptz,
  PRIMARY KEY (owner_id, id)
);
