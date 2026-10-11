-- =============================================================================
-- NetOps Policy Manager — PRODUCTION SCHEMA (consolidated)
-- =============================================================================
-- Run ONCE against an EMPTY `netops_policy` database (schema `public`) using
-- DBeaver or psql. This is the exact schema produced by the drizzle-kit
-- migrations 0000–0009, consolidated into a single idempotent-ordered script.
--
-- NOTES
--  * The app does NOT auto-migrate; this script replaces `npm run db:migrate`.
--  * Enum values added later by migrations 0008/0009 (LOGOUT, MFA_VERIFY) are
--    folded directly into CREATE TYPE here, so no ALTER TYPE ... ADD VALUE is
--    needed (that statement cannot run inside a transaction in some clients).
--  * gen_random_uuid() is built into PostgreSQL 13+ core (both dev and prod run
--    PostgreSQL 16), so no CREATE EXTENSION is required.
--  * This creates TABLES ONLY. Seed data (RBAC roles/permissions) is inserted
--    by a separate script; the first admin is assigned manually afterwards.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Enum types
-- ---------------------------------------------------------------------------
CREATE TYPE "public"."auth_provider" AS ENUM ('LOCAL', 'AD');
CREATE TYPE "public"."mfa_type" AS ENUM ('TOTP');

-- audit_action: base values (0005) + LOGOUT (0008) + MFA_VERIFY (0009)
CREATE TYPE "public"."audit_action" AS ENUM ('LOGIN', 'SHOW', 'ADD', 'DELETE', 'UPDATE', 'LOGOUT', 'MFA_VERIFY');
CREATE TYPE "public"."audit_module" AS ENUM ('AUTH', 'USER', 'ACL', 'ROUTE', 'N8N');
CREATE TYPE "public"."audit_status" AS ENUM ('SUCCESS', 'FAILED');

CREATE TYPE "public"."exec_log_action" AS ENUM ('SHOW', 'ADD', 'DELETE');
CREATE TYPE "public"."exec_log_status" AS ENUM ('SUCCESS', 'FAILED');

-- ---------------------------------------------------------------------------
-- users  (0000 + username from 0004 + role_id from 0003)
-- ---------------------------------------------------------------------------
CREATE TABLE "users" (
	"user_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar(255) NOT NULL,
	"display_name" varchar(150) NOT NULL,
	"password_hash" text,
	"auth_provider" "auth_provider" DEFAULT 'LOCAL' NOT NULL,
	"external_id" varchar(255),
	"is_active" boolean DEFAULT true NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"username" varchar(300),
	"role_id" uuid
);

-- ---------------------------------------------------------------------------
-- user_mfa  (0000 + label from 0002)
-- ---------------------------------------------------------------------------
CREATE TABLE "user_mfa" (
	"mfa_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"mfa_type" "mfa_type" DEFAULT 'TOTP' NOT NULL,
	"secret_encrypted" text NOT NULL,
	"is_enabled" boolean DEFAULT false NOT NULL,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"label" text DEFAULT 'Authenticator' NOT NULL
);

-- ---------------------------------------------------------------------------
-- sessions  (0001 + device-cred columns from 0006)
-- ---------------------------------------------------------------------------
CREATE TABLE "sessions" (
	"session_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"source_ip" varchar(64),
	"user_agent" varchar(512),
	"device_cred_encrypted" text,
	"device_cred_expires_at" timestamp with time zone
);

-- ---------------------------------------------------------------------------
-- RBAC: roles, permissions, roles_permissions  (0003)
-- ---------------------------------------------------------------------------
CREATE TABLE "roles" (
	"role_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"role_code" varchar(50) NOT NULL,
	"role_name" varchar(100) NOT NULL,
	"description" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "permissions" (
	"permission_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"permission_code" varchar(100) NOT NULL,
	"feature" varchar(50) NOT NULL,
	"action" varchar(30) NOT NULL,
	"description" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "roles_permissions" (
	"role_permission_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"role_id" uuid NOT NULL,
	"permission_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

-- ---------------------------------------------------------------------------
-- audit_logs  (0005)
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- acl_logs / route_logs  (0007) — audit detail, FK -> audit_logs
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- Foreign keys
-- ---------------------------------------------------------------------------
ALTER TABLE "user_mfa"
	ADD CONSTRAINT "user_mfa_user_id_users_user_id_fk"
	FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "sessions"
	ADD CONSTRAINT "sessions_user_id_users_user_id_fk"
	FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "roles_permissions"
	ADD CONSTRAINT "roles_permissions_role_id_roles_role_id_fk"
	FOREIGN KEY ("role_id") REFERENCES "public"."roles"("role_id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "roles_permissions"
	ADD CONSTRAINT "roles_permissions_permission_id_permissions_permission_id_fk"
	FOREIGN KEY ("permission_id") REFERENCES "public"."permissions"("permission_id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "users"
	ADD CONSTRAINT "users_role_id_roles_role_id_fk"
	FOREIGN KEY ("role_id") REFERENCES "public"."roles"("role_id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "audit_logs"
	ADD CONSTRAINT "audit_logs_user_id_users_user_id_fk"
	FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;

ALTER TABLE "acl_logs"
	ADD CONSTRAINT "acl_logs_audit_id_audit_logs_id_fk"
	FOREIGN KEY ("audit_id") REFERENCES "public"."audit_logs"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "route_logs"
	ADD CONSTRAINT "route_logs_audit_id_audit_logs_id_fk"
	FOREIGN KEY ("audit_id") REFERENCES "public"."audit_logs"("id") ON DELETE cascade ON UPDATE no action;

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
-- users
CREATE UNIQUE INDEX "users_email_uidx" ON "users" USING btree ("email");
CREATE UNIQUE INDEX "users_external_id_uidx" ON "users" USING btree ("external_id");
CREATE UNIQUE INDEX "users_username_uidx" ON "users" USING btree ("username") WHERE "users"."username" IS NOT NULL;
CREATE INDEX "users_role_id_idx" ON "users" USING btree ("role_id");

-- user_mfa
CREATE INDEX "user_mfa_user_id_idx" ON "user_mfa" USING btree ("user_id");

-- sessions
CREATE UNIQUE INDEX "sessions_token_hash_uidx" ON "sessions" USING btree ("token_hash");
CREATE INDEX "sessions_user_id_idx" ON "sessions" USING btree ("user_id");
CREATE INDEX "sessions_expires_at_idx" ON "sessions" USING btree ("expires_at");

-- RBAC
CREATE UNIQUE INDEX "roles_role_code_uidx" ON "roles" USING btree ("role_code");
CREATE UNIQUE INDEX "permissions_permission_code_uidx" ON "permissions" USING btree ("permission_code");
CREATE UNIQUE INDEX "permissions_feature_action_uidx" ON "permissions" USING btree ("feature","action");
CREATE UNIQUE INDEX "roles_permissions_role_perm_uidx" ON "roles_permissions" USING btree ("role_id","permission_id");

-- audit_logs
CREATE INDEX "audit_created_at_idx" ON "audit_logs" USING btree ("created_at");
CREATE INDEX "audit_user_id_idx" ON "audit_logs" USING btree ("user_id");
CREATE INDEX "audit_module_idx" ON "audit_logs" USING btree ("module");
CREATE INDEX "audit_action_idx" ON "audit_logs" USING btree ("action");
CREATE INDEX "audit_status_idx" ON "audit_logs" USING btree ("status");
CREATE INDEX "audit_change_ticket_idx" ON "audit_logs" USING btree ("change_ticket");
CREATE INDEX "audit_correlation_id_idx" ON "audit_logs" USING btree ("correlation_id");

-- acl_logs
CREATE INDEX "acl_logs_created_at_idx" ON "acl_logs" USING btree ("created_at");
CREATE INDEX "acl_logs_correlation_id_idx" ON "acl_logs" USING btree ("correlation_id");
CREATE INDEX "acl_logs_audit_id_idx" ON "acl_logs" USING btree ("audit_id");

-- route_logs
CREATE INDEX "route_logs_created_at_idx" ON "route_logs" USING btree ("created_at");
CREATE INDEX "route_logs_correlation_id_idx" ON "route_logs" USING btree ("correlation_id");
CREATE INDEX "route_logs_audit_id_idx" ON "route_logs" USING btree ("audit_id");
CREATE INDEX "route_logs_change_ticket_idx" ON "route_logs" USING btree ("change_ticket");

-- =============================================================================
-- END OF SCHEMA
-- Next: run the RBAC seed (roles/permissions), then assign the ADMINISTRATOR
-- role to your first AD user AFTER their first successful AD login.
-- =============================================================================
