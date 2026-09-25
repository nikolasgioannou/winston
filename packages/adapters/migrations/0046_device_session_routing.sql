ALTER TABLE winston.device_sessions
  ADD COLUMN server_id uuid,
  ADD COLUMN machine_id text CHECK (machine_id IS NULL OR machine_id ~ '^[a-f0-9]{8,32}$'),
  ADD CONSTRAINT device_session_routing_owner CHECK (machine_id IS NULL OR server_id IS NOT NULL);
