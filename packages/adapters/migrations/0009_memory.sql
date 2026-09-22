CREATE TABLE winston.memories (
  owner_id uuid NOT NULL REFERENCES winston.owners(id),
  id uuid NOT NULL,
  memory_key text NOT NULL,
  scope text NOT NULL,
  document jsonb NOT NULL,
  superseded_by uuid,
  PRIMARY KEY (owner_id, id),
  FOREIGN KEY (owner_id, superseded_by) REFERENCES winston.memories(owner_id, id) DEFERRABLE INITIALLY DEFERRED
);
--> statement-breakpoint
CREATE UNIQUE INDEX memories_current ON winston.memories (owner_id, scope, memory_key) WHERE superseded_by IS NULL;
--> statement-breakpoint
CREATE INDEX memories_search ON winston.memories USING gin (to_tsvector('simple', document->>'content')) WHERE superseded_by IS NULL;
