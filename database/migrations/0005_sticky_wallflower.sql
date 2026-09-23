CREATE TYPE "public"."audit_action" AS ENUM('LOGIN', 'SHOW', 'ADD', 'DELETE', 'UPDATE');--> statement-breakpoint
CREATE TYPE "public"."audit_module" AS ENUM('AUTH', 'USER', 'ACL', 'ROUTE', 'N8N');--> statement-breakpoint
CREATE TYPE "public"."audit_status" AS ENUM('SUCCESS', 'FAILED');--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"username" varchar(150),
	"user_role" varchar(100),
	"module" "audit_module" NOT NULL,
	"action" "audit_action" NOT NULL,
	"status" "audit_status" NOT NULL,
	"source_ip" varchar(64),
	"user_agent" varchar(512),
	"change_ticket" varchar(64),
	"correlation_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"request_payload" jsonb,
	"command_payload" jsonb,
	"execution_payload" jsonb,
	"response_payload" jsonb
);
--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_created_at_idx" ON "audit_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "audit_user_id_idx" ON "audit_logs" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "audit_module_idx" ON "audit_logs" USING btree ("module");--> statement-breakpoint
CREATE INDEX "audit_action_idx" ON "audit_logs" USING btree ("action");--> statement-breakpoint
CREATE INDEX "audit_status_idx" ON "audit_logs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "audit_change_ticket_idx" ON "audit_logs" USING btree ("change_ticket");--> statement-breakpoint
CREATE INDEX "audit_correlation_id_idx" ON "audit_logs" USING btree ("correlation_id");