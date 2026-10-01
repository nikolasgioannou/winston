ALTER TABLE "users" ADD COLUMN "browser_timezone" text;--> statement-breakpoint
-- Existing zones came from the browser, so they're what it last reported.
UPDATE "users" SET "browser_timezone" = "timezone";
