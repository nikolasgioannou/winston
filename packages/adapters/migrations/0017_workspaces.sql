CREATE TABLE winston.workspaces (
  owner_id uuid NOT NULL REFERENCES winston.owners(id),
  id uuid NOT NULL UNIQUE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  state text NOT NULL DEFAULT 'paused' CHECK (state IN ('paused', 'active', 'retired')),
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  PRIMARY KEY (owner_id, id)
);
