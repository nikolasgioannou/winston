CREATE TYPE "mail_direction" AS ENUM('received', 'sent');--> statement-breakpoint
CREATE TABLE "mailbox_messages" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"direction" "mail_direction" NOT NULL,
	"ses_message_id" text,
	"message_id_header" text,
	"in_reply_to" text,
	"references" text[] DEFAULT '{}'::text[] NOT NULL,
	"from" jsonb,
	"to" jsonb DEFAULT '[]' NOT NULL,
	"cc" jsonb DEFAULT '[]' NOT NULL,
	"reply_to" jsonb DEFAULT '[]' NOT NULL,
	"subject" text NOT NULL,
	"date" timestamp with time zone NOT NULL,
	"body" text NOT NULL,
	"quoted_text_hidden" boolean DEFAULT false NOT NULL,
	"snippet" text NOT NULL,
	"attachments" jsonb DEFAULT '[]' NOT NULL,
	"labels" text[] DEFAULT '{}'::text[] NOT NULL,
	"raw_blob_key" text NOT NULL,
	"size" bigint NOT NULL,
	"verdicts" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mailbox_threads" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"subject" text NOT NULL,
	"last_message_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "mailbox_messages_ses_id" ON "mailbox_messages" ("connection_id","ses_message_id") WHERE ses_message_id is not null;--> statement-breakpoint
CREATE INDEX "mailbox_messages_header_id" ON "mailbox_messages" ("connection_id","message_id_header");--> statement-breakpoint
CREATE INDEX "mailbox_messages_thread" ON "mailbox_messages" ("thread_id","date");--> statement-breakpoint
CREATE INDEX "mailbox_threads_recent" ON "mailbox_threads" ("connection_id","last_message_at");--> statement-breakpoint
ALTER TABLE "mailbox_messages" ADD CONSTRAINT "mailbox_messages_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "mailbox_messages" ADD CONSTRAINT "mailbox_messages_connection_id_connections_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "connections"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "mailbox_messages" ADD CONSTRAINT "mailbox_messages_thread_id_mailbox_threads_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "mailbox_threads"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "mailbox_threads" ADD CONSTRAINT "mailbox_threads_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "mailbox_threads" ADD CONSTRAINT "mailbox_threads_connection_id_connections_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "connections"("id") ON DELETE CASCADE;