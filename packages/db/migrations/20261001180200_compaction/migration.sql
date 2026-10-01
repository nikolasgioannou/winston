CREATE TYPE "run_message_kind" AS ENUM('message', 'compaction');--> statement-breakpoint
ALTER TABLE "run_messages" ADD COLUMN "kind" "run_message_kind" DEFAULT 'message'::"run_message_kind" NOT NULL;