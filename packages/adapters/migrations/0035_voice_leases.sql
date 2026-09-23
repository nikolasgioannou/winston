ALTER TABLE winston.telegram_intake
  ADD COLUMN voice_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN voice_token uuid,
  ADD COLUMN voice_leased_until timestamptz,
  ADD COLUMN voice_resolved_at timestamptz,
  ADD COLUMN voice_available_at timestamptz NOT NULL DEFAULT clock_timestamp();
--> statement-breakpoint
CREATE INDEX telegram_voice_pending ON winston.telegram_intake (owner_id, bot_id, voice_available_at, created_at, id)
  WHERE voice AND voice_resolved_at IS NULL AND state IN ('stored', 'staged');
