CREATE TABLE winston.credentials (
  owner_id uuid NOT NULL REFERENCES winston.owners(id),
  id uuid NOT NULL,
  provider text NOT NULL CHECK (provider = 'google'),
  revision integer NOT NULL CHECK (revision >= 0),
  encrypted jsonb,
  PRIMARY KEY (owner_id, id)
);
--> statement-breakpoint
CREATE TABLE winston.service_capabilities (
  owner_id uuid NOT NULL REFERENCES winston.owners(id),
  id uuid NOT NULL,
  token_hash text NOT NULL UNIQUE,
  document jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  PRIMARY KEY (owner_id, id)
);
