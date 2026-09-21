CREATE TABLE winston.events (
  owner_id uuid NOT NULL REFERENCES winston.owners(id),
  id text NOT NULL,
  type text NOT NULL,
  payload jsonb NOT NULL,
  destinations jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, id)
);
--> statement-breakpoint
CREATE TABLE winston.outbox (
  owner_id uuid NOT NULL,
  event_id text NOT NULL,
  destination text NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_token uuid,
  leased_until timestamptz,
  delivered_at timestamptz,
  failure_code text CHECK (failure_code = 'delivery-failed'),
  PRIMARY KEY (owner_id, event_id, destination),
  FOREIGN KEY (owner_id, event_id) REFERENCES winston.events(owner_id, id),
  CHECK ((lease_token IS NULL) = (leased_until IS NULL))
);
--> statement-breakpoint
CREATE INDEX outbox_pending ON winston.outbox (owner_id, destination, available_at, event_id)
  WHERE delivered_at IS NULL;
--> statement-breakpoint
CREATE TABLE winston.event_receipts (
  owner_id uuid NOT NULL,
  event_id text NOT NULL,
  consumer text NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, event_id, consumer),
  FOREIGN KEY (owner_id, event_id) REFERENCES winston.events(owner_id, id)
);
