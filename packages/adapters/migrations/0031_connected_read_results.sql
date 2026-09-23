CREATE TABLE winston.connected_read_results (
  owner_id uuid NOT NULL,
  action_id uuid NOT NULL,
  result jsonb NOT NULL,
  PRIMARY KEY (owner_id, action_id),
  FOREIGN KEY (owner_id, action_id) REFERENCES winston.actions(owner_id, id),
  CHECK (octet_length(result::text) <= 1048576)
);
