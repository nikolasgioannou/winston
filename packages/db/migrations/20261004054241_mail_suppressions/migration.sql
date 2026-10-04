CREATE TABLE "mail_suppressions" (
	"address" text PRIMARY KEY,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "mailbox_messages_sent" ON "mailbox_messages" ("connection_id","direction","created_at");