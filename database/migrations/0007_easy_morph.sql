CREATE TYPE "public"."exec_log_action" AS ENUM('SHOW', 'ADD', 'DELETE');--> statement-breakpoint
CREATE TYPE "public"."exec_log_status" AS ENUM('SUCCESS', 'FAILED');--> statement-breakpoint
CREATE TABLE "acl_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"audit_id" uuid NOT NULL,
	"correlation_id" uuid NOT NULL,
	"action" "exec_log_action" NOT NULL,
	"status" "exec_log_status" NOT NULL,
	"device" varchar(255),
	"source" varchar(255),
	"destination" varchar(255),
	"command_preview" jsonb,
	"execution_meta" jsonb,
	"response_summary" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "route_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"audit_id" uuid NOT NULL,
	"correlation_id" uuid NOT NULL,
	"action" "exec_log_action" NOT NULL,
	"status" "exec_log_status" NOT NULL,
	"device" varchar(255),
	"destination" varchar(255),
	"change_ticket" varchar(64),
	"command_preview" jsonb,
	"execution_meta" jsonb,
	"response_summary" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "acl_logs" ADD CONSTRAINT "acl_logs_audit_id_audit_logs_id_fk" FOREIGN KEY ("audit_id") REFERENCES "public"."audit_logs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "route_logs" ADD CONSTRAINT "route_logs_audit_id_audit_logs_id_fk" FOREIGN KEY ("audit_id") REFERENCES "public"."audit_logs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "acl_logs_created_at_idx" ON "acl_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "acl_logs_correlation_id_idx" ON "acl_logs" USING btree ("correlation_id");--> statement-breakpoint
CREATE INDEX "acl_logs_audit_id_idx" ON "acl_logs" USING btree ("audit_id");--> statement-breakpoint
CREATE INDEX "route_logs_created_at_idx" ON "route_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "route_logs_correlation_id_idx" ON "route_logs" USING btree ("correlation_id");--> statement-breakpoint
CREATE INDEX "route_logs_audit_id_idx" ON "route_logs" USING btree ("audit_id");--> statement-breakpoint
CREATE INDEX "route_logs_change_ticket_idx" ON "route_logs" USING btree ("change_ticket");