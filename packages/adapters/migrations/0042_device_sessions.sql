CREATE TABLE winston.device_sessions (
  owner_id uuid NOT NULL,
  device_id uuid NOT NULL,
  session_id uuid NOT NULL UNIQUE,
  generation bigint NOT NULL CHECK (generation BETWEEN 1 AND 9007199254740991),
  credential_hash text NOT NULL,
  reported_status text CHECK (reported_status IN ('ready', 'locked', 'sleeping', 'paused')),
  presence_revision integer NOT NULL DEFAULT 0 CHECK (presence_revision >= 0),
  last_seen_at timestamptz,
  lease_until timestamptz NOT NULL,
  disconnected_at timestamptz,
  PRIMARY KEY (owner_id, device_id),
  FOREIGN KEY (owner_id, device_id) REFERENCES winston.devices(owner_id, id)
);
--> statement-breakpoint
CREATE INDEX device_sessions_expiry ON winston.device_sessions (owner_id, lease_until, device_id)
  WHERE disconnected_at IS NULL;
