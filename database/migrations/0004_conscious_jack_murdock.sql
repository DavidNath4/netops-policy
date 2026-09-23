ALTER TABLE "users" ADD COLUMN "username" varchar(300);--> statement-breakpoint
CREATE UNIQUE INDEX "users_username_uidx" ON "users" USING btree ("username") WHERE "users"."username" IS NOT NULL;