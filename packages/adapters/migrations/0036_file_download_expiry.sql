ALTER TABLE winston.telegram_files ADD COLUMN created_at timestamptz NOT NULL DEFAULT clock_timestamp();
