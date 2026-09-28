ALTER TABLE "vms" ADD COLUMN "state_changed_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "vms" ADD CONSTRAINT "vms_token_hash_key" UNIQUE("token_hash");--> statement-breakpoint
ALTER TABLE "vms" ADD CONSTRAINT "vms_registration_token_hash_key" UNIQUE("registration_token_hash");