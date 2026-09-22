ALTER TABLE winston.conversations ADD COLUMN burst_started_at timestamptz;
--> statement-breakpoint
ALTER TABLE winston.conversations ADD COLUMN collect_until timestamptz;
--> statement-breakpoint
ALTER TABLE winston.conversation_messages ADD COLUMN conversation_revision integer NOT NULL DEFAULT 0;
