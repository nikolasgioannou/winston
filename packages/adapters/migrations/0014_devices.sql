CREATE TABLE winston.devices (
  owner_id uuid NOT NULL REFERENCES winston.owners(id),
  id uuid NOT NULL UNIQUE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  platform text NOT NULL CHECK (platform IN ('macos', 'windows', 'linux')),
  app_version text NOT NULL,
  protocol_version integer NOT NULL,
  capabilities jsonb NOT NULL,
  token_hash text UNIQUE,
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  is_default boolean NOT NULL DEFAULT false,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (owner_id, id),
  CHECK ((token_hash IS NULL) = (revoked_at IS NOT NULL)),
  CHECK (NOT is_default OR revoked_at IS NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX devices_default ON winston.devices (owner_id) WHERE is_default;
--> statement-breakpoint
CREATE TABLE winston.device_pairing (
  owner_id uuid PRIMARY KEY REFERENCES winston.owners(id),
  id uuid NOT NULL UNIQUE,
  name text NOT NULL,
  secret_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL
);
