-- =============================================================================
-- NetOps Policy Manager — PROMOTE FIRST ADMIN (AD-only production)
-- =============================================================================
-- Context: production is AD-only (AUTH_LOCAL_ENABLED=false). There is no seeded
-- LOCAL admin. A user row is created automatically the FIRST time an AD user
-- logs in successfully. After that first login, run ONE of the statements below
-- to grant that user the ADMINISTRATOR role.
--
-- STEP 1 — confirm the user exists (after their first AD login):
--   SELECT user_id, email, username, display_name, auth_provider, role_id, is_active
--   FROM users ORDER BY created_at DESC;
--
-- STEP 2 — promote. Pick the identifier you know (email OR AD username) and
-- replace the placeholder, then run that single UPDATE.
-- =============================================================================

-- --- Option A: promote by email -------------------------------------------
UPDATE "users"
SET "role_id" = (SELECT "role_id" FROM "roles" WHERE "role_code" = 'ADMINISTRATOR'),
    "updated_at" = now()
WHERE "email" = 'REPLACE_WITH_EMAIL';   -- e.g. nama.user@mov.co.id

-- --- Option B: promote by AD username (sAMAccountName) ----------------------
-- UPDATE "users"
-- SET "role_id" = (SELECT "role_id" FROM "roles" WHERE "role_code" = 'ADMINISTRATOR'),
--     "updated_at" = now()
-- WHERE "username" = 'REPLACE_WITH_AD_USERNAME';   -- e.g. saconnect

-- --- Verify ------------------------------------------------------------------
--   SELECT u.email, u.username, r.role_code
--   FROM users u JOIN roles r ON r.role_id = u.role_id
--   WHERE r.role_code = 'ADMINISTRATOR';
-- =============================================================================
