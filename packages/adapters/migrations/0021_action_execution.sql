CREATE UNIQUE INDEX actions_execution ON winston.actions (owner_id, (document->>'operationId'));
