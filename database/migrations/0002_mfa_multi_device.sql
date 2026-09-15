-- Allow up to two TOTP devices per user (max enforced in the service layer).
-- Drop the single-device unique index, add a device label, and index user_id.
DROP INDEX "user_mfa_user_id_uidx";--> statement-breakpoint
ALTER TABLE "user_mfa" ADD COLUMN "label" text DEFAULT 'Authenticator' NOT NULL;--> statement-breakpoint
CREATE INDEX "user_mfa_user_id_idx" ON "user_mfa" USING btree ("user_id");
