ALTER TABLE "sessions" ADD COLUMN "device_cred_encrypted" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "device_cred_expires_at" timestamp with time zone;