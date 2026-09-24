CREATE TABLE winston.responsibilities (
  owner_id uuid NOT NULL REFERENCES winston.owners(id),
  id uuid NOT NULL,
  request_key text NOT NULL,
  request_hash text NOT NULL,
  document jsonb NOT NULL,
  PRIMARY KEY (owner_id, id),
  UNIQUE (owner_id, request_key)
);
--> statement-breakpoint
CREATE TABLE winston.responsibility_history (
  owner_id uuid NOT NULL,
  responsibility_id uuid NOT NULL,
  revision integer NOT NULL,
  document jsonb NOT NULL,
  PRIMARY KEY (owner_id, responsibility_id, revision),
  FOREIGN KEY (owner_id, responsibility_id) REFERENCES winston.responsibilities(owner_id, id)
);
