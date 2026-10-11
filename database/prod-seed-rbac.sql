-- =============================================================================
-- NetOps Policy Manager — PRODUCTION RBAC SEED
-- =============================================================================
-- Run ONCE after prod-schema.sql, against the `netops_policy` database.
-- Inserts the initial roles, permissions, and role->permission mapping — the
-- exact data from shared/constants/rbac.ts (ROLE_DEFS, PERMISSION_DEFS,
-- ROLE_PERMISSION_MAP). This replaces the RBAC part of `npm run db:seed`.
--
-- Idempotent: safe to re-run (ON CONFLICT DO NOTHING on the unique keys).
-- Does NOT create any user. The first admin is assigned separately AFTER an
-- AD user has logged in once (see prod-admin-promote.sql).
--
-- permission_code = '<FEATURE>_<ACTION>'  (e.g. ACL_POLICIES_SHOW).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Roles
-- ---------------------------------------------------------------------------
INSERT INTO "roles" ("role_code", "role_name", "description") VALUES
	('ADMINISTRATOR', 'Administrator', 'Full access to all features and administration.'),
	('L2_ENGINEER',   'L2 Engineer',   'Show, add, and delete ACL policies and routes.'),
	('NOC',           'NOC',           'Show and add ACL policies and routes.')
ON CONFLICT ("role_code") DO NOTHING;

-- ---------------------------------------------------------------------------
-- Permissions  (feature, action)  -> code = feature || '_' || action
-- ---------------------------------------------------------------------------
INSERT INTO "permissions" ("permission_code", "feature", "action") VALUES
	('ACL_POLICIES_SHOW',    'ACL_POLICIES',   'SHOW'),
	('ACL_POLICIES_ADD',     'ACL_POLICIES',   'ADD'),
	('ACL_POLICIES_DELETE',  'ACL_POLICIES',   'DELETE'),
	('ROUTES_SHOW',          'ROUTES',         'SHOW'),
	('ROUTES_ADD',           'ROUTES',         'ADD'),
	('ROUTES_DELETE',        'ROUTES',         'DELETE'),
	('ADMINISTRATION_SHOW',  'ADMINISTRATION', 'SHOW'),
	('ADMINISTRATION_MANAGE','ADMINISTRATION', 'MANAGE')
ON CONFLICT ("permission_code") DO NOTHING;

-- ---------------------------------------------------------------------------
-- Role -> Permission mapping
--   NOC          : ACL show/add, ROUTES show/add
--   L2_ENGINEER  : ACL show/add/delete, ROUTES show/add/delete
--   ADMINISTRATOR: all of the above + ADMINISTRATION show/manage
-- Resolves role_id / permission_id by their codes, so it is stable regardless
-- of the generated UUIDs.
-- ---------------------------------------------------------------------------
INSERT INTO "roles_permissions" ("role_id", "permission_id")
SELECT r."role_id", p."permission_id"
FROM "roles" r
JOIN "permissions" p ON TRUE
WHERE
	(r."role_code" = 'NOC' AND p."permission_code" IN (
		'ACL_POLICIES_SHOW', 'ACL_POLICIES_ADD',
		'ROUTES_SHOW', 'ROUTES_ADD'
	))
	OR
	(r."role_code" = 'L2_ENGINEER' AND p."permission_code" IN (
		'ACL_POLICIES_SHOW', 'ACL_POLICIES_ADD', 'ACL_POLICIES_DELETE',
		'ROUTES_SHOW', 'ROUTES_ADD', 'ROUTES_DELETE'
	))
	OR
	(r."role_code" = 'ADMINISTRATOR' AND p."permission_code" IN (
		'ACL_POLICIES_SHOW', 'ACL_POLICIES_ADD', 'ACL_POLICIES_DELETE',
		'ROUTES_SHOW', 'ROUTES_ADD', 'ROUTES_DELETE',
		'ADMINISTRATION_SHOW', 'ADMINISTRATION_MANAGE'
	))
ON CONFLICT ("role_id", "permission_id") DO NOTHING;

-- =============================================================================
-- Verify (optional):
--   SELECT r.role_code, count(*) AS perms
--   FROM roles r
--   LEFT JOIN roles_permissions rp ON rp.role_id = r.role_id
--   GROUP BY r.role_code ORDER BY r.role_code;
-- Expected: ADMINISTRATOR=8, L2_ENGINEER=6, NOC=4
-- =============================================================================
