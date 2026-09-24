ALTER TABLE winston.device_sessions
  ADD COLUMN capabilities jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(capabilities) = 'array' AND jsonb_array_length(capabilities) <= 6
      AND capabilities <@ '["command", "file.read", "file.write", "observe", "input", "application"]'::jsonb),
  ADD COLUMN capability_revision integer NOT NULL DEFAULT 0 CHECK (capability_revision >= 0);
