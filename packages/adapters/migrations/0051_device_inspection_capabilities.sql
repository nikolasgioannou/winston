ALTER TABLE winston.device_sessions
  DROP CONSTRAINT device_sessions_capabilities_check,
  ADD CONSTRAINT device_sessions_capabilities_check
    CHECK (jsonb_typeof(capabilities) = 'array' AND jsonb_array_length(capabilities) <= 8
      AND capabilities <@ '["command", "file.read", "file.write", "observe", "input", "application", "file.metadata", "file.list"]'::jsonb);
