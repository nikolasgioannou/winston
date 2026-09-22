CREATE TABLE winston.authorization_state (
  owner_id uuid PRIMARY KEY REFERENCES winston.owners(id),
  revision integer NOT NULL CHECK (revision > 0)
);
--> statement-breakpoint
CREATE TABLE winston.authorization_rules (
  owner_id uuid NOT NULL REFERENCES winston.owners(id),
  kind text NOT NULL CHECK (kind IN ('connection', 'device')),
  target_id uuid NOT NULL,
  resource_key text NOT NULL,
  operation text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('allow', 'ask', 'deny')),
  PRIMARY KEY (owner_id, kind, target_id, resource_key, operation)
);
