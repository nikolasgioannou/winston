CREATE TABLE winston.task_resource_bindings (
  owner_id uuid NOT NULL,
  task_id uuid NOT NULL,
  intent_revision integer NOT NULL CHECK (intent_revision >= 0),
  binding_key text NOT NULL CHECK (length(binding_key) BETWEEN 1 AND 100),
  document jsonb NOT NULL,
  PRIMARY KEY (owner_id, task_id, intent_revision, binding_key),
  FOREIGN KEY (owner_id, task_id) REFERENCES winston.tasks(owner_id, id) ON DELETE CASCADE
);
--> statement-breakpoint
INSERT INTO winston.task_resource_bindings (owner_id, task_id, intent_revision, binding_key, document)
SELECT b.owner_id, b.task_id, t.intent_revision, b.operation,
  jsonb_build_object('taskId', b.task_id, 'intentRevision', t.intent_revision, 'key', b.operation,
    'authorization', jsonb_build_object('operation', b.operation,
      'target', jsonb_build_object('kind', 'connection', 'id', b.document->>'connectionId', 'resource', b.document->'calendarId')),
    'resourceRevision', (c.document->>'revision')::integer)
FROM winston.task_connection_targets b
JOIN winston.tasks t ON t.owner_id = b.owner_id AND t.id = b.task_id
JOIN winston.google_connections c ON c.owner_id = b.owner_id AND c.id = (b.document->>'connectionId')::uuid
WHERE b.task_revision = (t.document->>'revision')::integer;
