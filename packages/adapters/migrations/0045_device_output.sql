ALTER TABLE winston.device_executions
  ADD COLUMN last_sequence bigint NOT NULL DEFAULT -1 CHECK (last_sequence BETWEEN -1 AND 9007199254740991),
  ADD COLUMN output_bytes integer NOT NULL DEFAULT 0 CHECK (output_bytes BETWEEN 0 AND 3145728),
  ADD COLUMN output_count integer NOT NULL DEFAULT 0 CHECK (output_count BETWEEN 0 AND 4096);
--> statement-breakpoint
UPDATE winston.device_executions SET last_sequence = COALESCE((document #>> '{receipt,payload,sequence}')::bigint, -1);
--> statement-breakpoint
CREATE TABLE winston.device_output (
  owner_id uuid NOT NULL,
  execution_id uuid NOT NULL,
  sequence bigint NOT NULL CHECK (sequence BETWEEN 0 AND 9007199254740991),
  document jsonb NOT NULL,
  PRIMARY KEY (owner_id, execution_id, sequence),
  FOREIGN KEY (owner_id, execution_id) REFERENCES winston.device_executions(owner_id, execution_id)
);
