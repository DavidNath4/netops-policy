// Data-driven RBAC catalog — the single source of truth for the seed data and
// for the permission codes referenced in code. Roles/permissions/mapping live
// in the database; these constants describe the INITIAL data to seed and give
// the server/frontend stable code strings to check against.
//
// Adding a brand-new role at runtime does NOT require editing this file — a new
// role is just new rows in `roles` + `roles_permissions`. This catalog only
// captures the initial seed and the known permission codes.

export const FEATURES = {
  ACL_POLICIES: 'ACL_POLICIES',
  ROUTES: 'ROUTES',
  ADMINISTRATION: 'ADMINISTRATION',
} as const

export const ACTIONS = {
  SHOW: 'SHOW',
  ADD: 'ADD',
  DELETE: 'DELETE',
  MANAGE: 'MANAGE',
} as const

/** Every seeded permission as `{ feature, action }`; code = `<FEATURE>_<ACTION>`. */
export const PERMISSION_DEFS = [
  { feature: FEATURES.ACL_POLICIES, action: ACTIONS.SHOW },
  { feature: FEATURES.ACL_POLICIES, action: ACTIONS.ADD },
  { feature: FEATURES.ACL_POLICIES, action: ACTIONS.DELETE },
  { feature: FEATURES.ROUTES, action: ACTIONS.SHOW },
  { feature: FEATURES.ROUTES, action: ACTIONS.ADD },
  { feature: FEATURES.ROUTES, action: ACTIONS.DELETE },
  { feature: FEATURES.ADMINISTRATION, action: ACTIONS.SHOW },
  { feature: FEATURES.ADMINISTRATION, action: ACTIONS.MANAGE },
] as const

/** Build a permission code from a feature + action. */
export function permissionCode(feature: string, action: string): string {
  return `${feature}_${action}`
}

/** Known permission codes (for type-safe references in handlers/UI). */
export const PERMISSIONS = {
  ACL_POLICIES_SHOW: 'ACL_POLICIES_SHOW',
  ACL_POLICIES_ADD: 'ACL_POLICIES_ADD',
  ACL_POLICIES_DELETE: 'ACL_POLICIES_DELETE',
  ROUTES_SHOW: 'ROUTES_SHOW',
  ROUTES_ADD: 'ROUTES_ADD',
  ROUTES_DELETE: 'ROUTES_DELETE',
  ADMINISTRATION_SHOW: 'ADMINISTRATION_SHOW',
  ADMINISTRATION_MANAGE: 'ADMINISTRATION_MANAGE',
} as const

export type PermissionCode = typeof PERMISSIONS[keyof typeof PERMISSIONS]

export const ROLE_CODES = {
  ADMINISTRATOR: 'ADMINISTRATOR',
  L2_ENGINEER: 'L2_ENGINEER',
  NOC: 'NOC',
} as const

export type RoleCode = typeof ROLE_CODES[keyof typeof ROLE_CODES]

/** Initial roles to seed. */
export const ROLE_DEFS: { code: RoleCode, name: string, description: string }[] = [
  { code: ROLE_CODES.ADMINISTRATOR, name: 'Administrator', description: 'Full access to all features and administration.' },
  { code: ROLE_CODES.L2_ENGINEER, name: 'L2 Engineer', description: 'Show, add, and delete ACL policies and routes.' },
  { code: ROLE_CODES.NOC, name: 'NOC', description: 'Show and add ACL policies and routes.' },
]

/** Initial role → permission-code mapping to seed. */
export const ROLE_PERMISSION_MAP: Record<RoleCode, PermissionCode[]> = {
  NOC: [
    PERMISSIONS.ACL_POLICIES_SHOW,
    PERMISSIONS.ACL_POLICIES_ADD,
    PERMISSIONS.ROUTES_SHOW,
    PERMISSIONS.ROUTES_ADD,
  ],
  L2_ENGINEER: [
    PERMISSIONS.ACL_POLICIES_SHOW,
    PERMISSIONS.ACL_POLICIES_ADD,
    PERMISSIONS.ACL_POLICIES_DELETE,
    PERMISSIONS.ROUTES_SHOW,
    PERMISSIONS.ROUTES_ADD,
    PERMISSIONS.ROUTES_DELETE,
  ],
  ADMINISTRATOR: [
    PERMISSIONS.ACL_POLICIES_SHOW,
    PERMISSIONS.ACL_POLICIES_ADD,
    PERMISSIONS.ACL_POLICIES_DELETE,
    PERMISSIONS.ROUTES_SHOW,
    PERMISSIONS.ROUTES_ADD,
    PERMISSIONS.ROUTES_DELETE,
    PERMISSIONS.ADMINISTRATION_SHOW,
    PERMISSIONS.ADMINISTRATION_MANAGE,
  ],
}
