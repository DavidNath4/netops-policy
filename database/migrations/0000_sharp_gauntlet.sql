CREATE TYPE "public"."auth_provider" AS ENUM('LOCAL', 'AD');--> statement-breakpoint
CREATE TYPE "public"."mfa_type" AS ENUM('TOTP');--> statement-breakpoint
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
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_mfa" (
	"mfa_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"mfa_type" "mfa_type" DEFAULT 'TOTP' NOT NULL,
	"secret_encrypted" text NOT NULL,
	"is_enabled" boolean DEFAULT false NOT NULL,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_mfa" ADD CONSTRAINT "user_mfa_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_uidx" ON "users" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "users_external_id_uidx" ON "users" USING btree ("external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_mfa_user_id_uidx" ON "user_mfa" USING btree ("user_id");