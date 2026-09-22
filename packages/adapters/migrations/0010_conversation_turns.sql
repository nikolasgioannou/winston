ALTER TABLE winston.conversations ADD COLUMN input_revision integer NOT NULL DEFAULT 0;
--> statement-breakpoint
UPDATE winston.conversations SET input_revision = revision;
--> statement-breakpoint
CREATE TABLE winston.conversation_turns (
  owner_id uuid NOT NULL REFERENCES winston.owners(id),
  revision integer NOT NULL,
  anchor_id uuid NOT NULL,
  response_id uuid,
  PRIMARY KEY (owner_id, revision),
  FOREIGN KEY (owner_id, anchor_id) REFERENCES winston.conversation_messages(owner_id, id),
  FOREIGN KEY (owner_id, response_id) REFERENCES winston.telegram_outbound(owner_id, id)
);
--> statement-breakpoint
CREATE TABLE winston.conversation_rounds (
  owner_id uuid NOT NULL,
  revision integer NOT NULL,
  step integer NOT NULL CHECK (step >= 0 AND step < 4),
  document jsonb NOT NULL,
  PRIMARY KEY (owner_id, revision, step),
  FOREIGN KEY (owner_id, revision) REFERENCES winston.conversation_turns(owner_id, revision)
);
--> statement-breakpoint
CREATE TABLE winston.conversation_tool_results (
  owner_id uuid NOT NULL,
  revision integer NOT NULL,
  step integer NOT NULL,
  call_id text NOT NULL,
  result jsonb NOT NULL,
  PRIMARY KEY (owner_id, revision, step, call_id),
  FOREIGN KEY (owner_id, revision, step) REFERENCES winston.conversation_rounds(owner_id, revision, step)
);
