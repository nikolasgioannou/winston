CREATE TABLE winston.artifacts (
  owner_id uuid NOT NULL REFERENCES winston.owners(id),
  id uuid NOT NULL,
  request_key text NOT NULL,
  document jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (owner_id, id),
  UNIQUE (owner_id, request_key)
);
--> statement-breakpoint
CREATE INDEX artifacts_state ON winston.artifacts (owner_id, (document->>'state'), id);
