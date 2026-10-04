ALTER TYPE "site_access" ADD VALUE 'link';--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN "share_key" text;